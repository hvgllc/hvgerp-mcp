/**
 * ERPNext OMS Tools
 *
 * MCP tools for marketplace sales: merchant accounts (`HVG Merchant Account`) and the
 * marketplace Sales Orders synced into them.
 *
 * @module lib/erpnext/tools/oms
 */

import type { ErpNextTool, ErpNextToolContext } from "./types.ts";
import { callHvgWorkspace } from "./hvg-workspace.ts";

// ── Vì sao đi qua wrapper ───────────────────────────────────────────────────
//
// Đơn sàn là `Sales Order` gốc có thêm các field `hvg_*`, nhưng ERP chặn mọi lượt ghi trực
// tiếp lên nó ngoài `sdc_api_write_scope()`: `erpnext_sales_order_update` gặp đơn sàn là bị
// từ chối. Đọc qua `/api/resource` thì thiếu tài khoản, giai đoạn xử lý và dấu vân tay cấu
// trúc đơn.
//
// Vì vậy mọi tool ở đây gọi `hvg_workspace.api_token_reads.*`, lớp bọc ERP dựng riêng cho
// token: trần 50 dòng mỗi trang, cursor ổn định, bỏ thông tin người mua khỏi danh sách, ghi
// Sensitive Action Log cho mỗi lượt đọc chi tiết đơn, và cố ý không mở tạo, xoá, gộp, tách,
// gửi xưởng in hay xem secret. Gọi thẳng `hvg_sdc_sync.api` là bỏ qua tất cả những thứ đó.
//
// Luật nghiệp vụ (giai đoạn hợp lệ, ai được sửa email, quyền theo phòng ban) chỉ có một nguồn
// là ERP. Phía này chỉ chặn những đầu vào mà ERP sẽ hiểu sai một cách lặng lẽ.

const WRAPPERS = "hvg_workspace.api_token_reads";

/** Câu nói rõ nhóm tool này cần app nào, dùng khi site không có hàm. */
const OMS_MISSING_APP =
  "Merchant account and marketplace order tools need the 'hvg_workspace' app " +
  "(with 'hvg_sdc_sync') installed.";

/** Câu chung cho mô tả tool: quyền nào áp dụng và tool phụ thuộc vào đâu. */
const OMS_SCOPE =
  "Runs under the caller's own ERP permissions, so results follow the same " +
  "department scope as the Orders page in the HVG workspace. Requires the " +
  "'hvg_workspace' and 'hvg_sdc_sync' apps on the site.";

/** Tám giá trị `hvg_fulfill_stage`, khớp `hvg_sdc_sync.api.FULFILL_STAGES`. Chỉ để mô tả. */
const FULFILL_STAGE_HINT =
  "NeedSellerCheck, NeedConfirm, NeedDesign, NeedFulfill, WaitTracking, " +
  "NeedAddTrackToAccount, FollowTracking, Done";

/** Các sàn mà `merchant_type` nhận. Chỉ để mô tả; ERP mới là nơi kiểm. */
const MERCHANT_TYPE_HINT =
  "Unassigned, Amazon, TikTok, TikTokUk, TikTokDe, Ebay, Etsy, Depop";

/** Bốn vị trí design theo đúng thứ tự dòng mà ERP lưu trong `hvg_design_link`. */
const DESIGN_POSITIONS = ["front", "back", "left", "right"] as const;

/** Một dòng trong danh sách mà hai hàm list của wrapper trả về. */
type Row = Record<string, unknown>;

/** Phần của `list_sales_orders` / `list_merchant_accounts` mà tool giữ lại. */
interface WrapperPage {
  rows?: Row[];
  total?: number;
  summary?: unknown;
  states?: unknown;
  next_cursor?: string | null;
}

function call<T>(
  ctx: ErpNextToolContext,
  fn: string,
  args: Record<string, unknown>,
  tool: string,
): Promise<T> {
  // Mọi wrapper ở đây đều nhận POST, và hai wrapper chỉ nhận POST: `get_sales_order` (dòng
  // audit chỉ sống khi request được commit, mà Frappe rollback mọi GET) cùng các wrapper ghi.
  // Ghi rõ thay vì dựa vào mặc định của `callMethod`, để không ai đổi mặc định mà làm mất
  // dòng audit một cách lặng lẽ.
  return callHvgWorkspace<T>(
    ctx,
    `${WRAPPERS}.${fn}`,
    args,
    tool,
    OMS_MISSING_APP,
    { httpMethod: "POST" },
  );
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[${tool}] '${key}' is required`);
  }
  return value;
}

/** Chép `input[key]` sang `args` nếu có, sau khi kiểm đúng là chuỗi. */
function copyString(
  input: Record<string, unknown>,
  args: Record<string, unknown>,
  key: string,
  tool: string,
): void {
  const value = input[key];
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error(`[${tool}] '${key}' must be a string`);
  }
  args[key] = value;
}

/**
 * Chép một bộ lọc danh sách sang `args` nếu có.
 *
 * Từ chối thứ không phải mảng chuỗi ngay tại đây: ERP đọc đối số danh sách bằng `_parse_list`,
 * vốn nhận cả chuỗi JSON lẫn chuỗi phân cách bằng dấu phẩy, nên một chuỗi trần như "TikTok" có
 * thể bị hiểu thành một bộ lọc khác với bộ lọc người gọi định gửi.
 */
function copyStringArray(
  input: Record<string, unknown>,
  args: Record<string, unknown>,
  key: string,
  tool: string,
): void {
  const value = input[key];
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`[${tool}] '${key}' must be an array of strings`);
  }
  if (value.length > 0) args[key] = value;
}

function copyPageLength(
  input: Record<string, unknown>,
  args: Record<string, unknown>,
  tool: string,
): void {
  const value = input.page_length;
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`[${tool}] 'page_length' must be a positive integer`);
  }
  args.page_length = value;
}

/** Câu hướng dẫn đọc trang tiếp theo, hoặc nói rõ đây là trang cuối. */
function pageMessage(
  page: WrapperPage,
  returned: number,
  what: string,
): string {
  const total = typeof page.total === "number" ? ` of ${page.total}` : "";
  if (page.next_cursor) {
    return `Returned ${returned}${total} ${what}. More remain: call again with the ` +
      `same filters and cursor='${page.next_cursor}'.`;
  }
  return `Returned ${returned}${total} ${what}. This is the last page.`;
}

const CURSOR_PROPERTY = {
  type: "string",
  description:
    "Opaque cursor from the previous page's next_cursor. Omit for the first page; " +
    "keep every other filter unchanged when paging.",
};

const PAGE_LENGTH_PROPERTY = {
  type: "number",
  description: "Rows per page, 1-50 (default 50; ERP caps it at 50).",
};

const STRING_ARRAY = { type: "array", items: { type: "string" } };

// ── Item update ─────────────────────────────────────────────────────────────

/** Mỗi field của `erpnext_merchant_order_item_update` ứng với một wrapper và một tên đối số. */
const ITEM_FIELDS: Record<string, { fn: string; arg: string }> = {
  note: { fn: "update_sales_order_item_note", arg: "note" },
  tracking_number: {
    fn: "update_sales_order_item_tracking",
    arg: "tracking_number",
  },
  label_link: { fn: "update_sales_order_item_label_link", arg: "label_link" },
  design_link: {
    fn: "update_sales_order_item_design_link",
    arg: "design_link",
  },
  fulfill_stage: { fn: "update_sales_order_item_fulfill_stage", arg: "stage" },
};

/**
 * Ghép bốn link design thành chuỗi bốn dòng Front/Back/Left/Right mà ERP lưu.
 *
 * Bắt đủ bốn khoá thay vì nhận một mảng hay một chuỗi: ERP đọc theo VỊ TRÍ dòng, nên thiếu một
 * phần tử là mọi link sau nó trượt sang vị trí khác mà không ai báo lỗi. Một link chứa xuống
 * dòng cũng làm trượt y như vậy, nên bị từ chối.
 */
function joinDesignLinks(value: unknown, tool: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `[${tool}] 'design_link' must be an object with front, back, left and right`,
    );
  }
  const links = value as Record<string, unknown>;
  return DESIGN_POSITIONS.map((position) => {
    const link = links[position];
    if (typeof link !== "string") {
      throw new Error(
        `[${tool}] 'design_link.${position}' must be a string ('' for no image)`,
      );
    }
    if (/[\r\n]/.test(link)) {
      throw new Error(
        `[${tool}] 'design_link.${position}' must not contain a line break`,
      );
    }
    return link.trim();
  }).join("\n");
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const omsTools: ErpNextTool[] = [
  {
    name: "erpnext_merchant_account_list",
    annotations: { readOnlyHint: true },
    description:
      "List marketplace merchant accounts (HVG Merchant Account: the Amazon, TikTok, " +
      "eBay, Etsy and Depop shops the company sells through) that the caller can see. " +
      "Defaults to Active accounts. Paged by cursor: when next_cursor is not null, call " +
      "again with cursor=next_cursor. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["Active", "Draft", "Closed", "all"],
          description: "Account status filter (default Active)",
        },
        merchant_types: {
          ...STRING_ARRAY,
          description: `Marketplace filter. Values: ${MERCHANT_TYPE_HINT}`,
        },
        responsible_departments: {
          ...STRING_ARRAY,
          description: "Only accounts owned by these Departments",
        },
        search: {
          type: "string",
          description: "Free-text search on account id, name and email",
        },
        cursor: CURSOR_PROPERTY,
        page_length: PAGE_LENGTH_PROPERTY,
      },
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_account_list";
      const args: Record<string, unknown> = {};
      copyString(input, args, "status", tool);
      copyStringArray(input, args, "merchant_types", tool);
      copyStringArray(input, args, "responsible_departments", tool);
      copyString(input, args, "search", tool);
      copyString(input, args, "cursor", tool);
      copyPageLength(input, args, tool);
      const page = await call<WrapperPage>(
        ctx,
        "list_merchant_accounts",
        args,
        tool,
      );
      const rows = page.rows ?? [];
      return {
        data: rows,
        total: page.total ?? null,
        summary: page.summary ?? null,
        next_cursor: page.next_cursor ?? null,
        message: pageMessage(page, rows.length, "accounts"),
      };
    },
  },

  {
    name: "erpnext_merchant_account_get",
    annotations: { readOnlyHint: true },
    description:
      "Read one merchant account: marketplace, status, owning departments, order count " +
      "and last order date, plus what the caller may change (can_write, " +
      "can_edit_departments). Fields the caller may not read are already removed by " +
      "ERP, and marketplace secrets are always masked. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Merchant account id (the 'name' from erpnext_merchant_account_list)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_account_get";
      const name = requireString(input, "name", tool);
      const doc = await call<Row>(ctx, "get_merchant_account", { name }, tool);
      return { data: doc };
    },
  },

  {
    name: "erpnext_merchant_account_update",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    description:
      "Change a merchant account's marketplace type, status, display name or main " +
      "email. Pass only the fields to change; at least one is required. Changing " +
      "main_email needs a department head or IT/Admin. Creating or deleting accounts, " +
      "changing owning departments and revealing secrets are deliberately not " +
      "available. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Merchant account id" },
        merchant_type: {
          type: "string",
          description: `New marketplace. Values: ${MERCHANT_TYPE_HINT}`,
        },
        status: {
          type: "string",
          description: "New status: Draft, Active or Closed",
        },
        merchant_name: { type: "string", description: "New display name" },
        main_email: {
          type: "string",
          description: "New main email ('' clears it)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_account_update";
      const name = requireString(input, "name", tool);
      const args: Record<string, unknown> = { name };
      const fields = ["merchant_type", "status", "merchant_name", "main_email"];
      for (const field of fields) copyString(input, args, field, tool);
      // ERP tự `save()` cả khi không có field nào, thành một lượt ghi rỗng có vết. Wrapper đã
      // chặn, nhưng chặn ở đây thì người gọi nhận câu tiếng Anh đúng tên field của tool này.
      if (Object.keys(args).length === 1) {
        throw new Error(
          `[${tool}] pass at least one of ${fields.join(", ")}`,
        );
      }
      const doc = await call<Row>(ctx, "update_merchant_account", args, tool);
      // Ghi đi qua `callMethod` nên client không tự dọn cache như với `update()`.
      ctx.client.invalidate("HVG Merchant Account", name);
      return { data: doc, message: `Merchant account ${name} updated` };
    },
  },

  {
    name: "erpnext_merchant_order_list",
    annotations: { readOnlyHint: true },
    description:
      "List marketplace sales orders (Sales Orders synced from a merchant account) the " +
      "caller can see, newest first. Each row is ONE ORDER ITEM, not one order: an order " +
      "with three items appears as three rows sharing the same 'name'. Rows carry " +
      "row_name, item_code, fulfill_stage, item_tracking_number, item_note and the " +
      "order's structure_version. Buyer name, address and note are never included; use " +
      "erpnext_merchant_order_get for those. Paged by cursor: when next_cursor is not " +
      "null, call again with the same filters and cursor=next_cursor. Prefer this over " +
      "erpnext_sales_order_list for marketplace orders. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "canceled", "all"],
          description: "Order status filter (default active)",
        },
        merchants: {
          ...STRING_ARRAY,
          description: "Merchant account ids",
        },
        merchant_types: {
          ...STRING_ARRAY,
          description: `Marketplaces. Values: ${MERCHANT_TYPE_HINT}`,
        },
        fulfill_stages: {
          ...STRING_ARRAY,
          description: `Item fulfill stages. Values: ${FULFILL_STAGE_HINT}`,
        },
        item_categories: {
          ...STRING_ARRAY,
          description: "Item Groups of the order items",
        },
        fulfill_units: {
          ...STRING_ARRAY,
          description: "Fulfilment vendors of the order items",
        },
        sales_teams: {
          ...STRING_ARRAY,
          description: "Sales team Departments owning the merchant account",
        },
        search: {
          type: "string",
          description:
            "Free-text search on order id, marketplace order id, tracking number and item note",
        },
        date_from: {
          type: "string",
          description: "Earliest transaction date, YYYY-MM-DD",
        },
        date_to: {
          type: "string",
          description: "Latest transaction date, YYYY-MM-DD",
        },
        cursor: CURSOR_PROPERTY,
        page_length: {
          type: "number",
          description:
            "Orders per page, 1-50 (default 50). Rows can exceed this because each order " +
            "contributes one row per item.",
        },
      },
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_order_list";
      const args: Record<string, unknown> = {};
      copyString(input, args, "status", tool);
      for (
        const key of [
          "merchants",
          "merchant_types",
          "fulfill_stages",
          "item_categories",
          "fulfill_units",
          "sales_teams",
        ]
      ) {
        copyStringArray(input, args, key, tool);
      }
      copyString(input, args, "search", tool);
      copyString(input, args, "date_from", tool);
      copyString(input, args, "date_to", tool);
      copyString(input, args, "cursor", tool);
      copyPageLength(input, args, tool);
      const page = await call<WrapperPage>(
        ctx,
        "list_sales_orders",
        args,
        tool,
      );
      // Bỏ phần metadata dựng riêng cho SPA (danh sách tài khoản, team, cờ `can_*`, các tuỳ
      // chọn bộ lọc): nó lặp lại ở mọi trang, chiếm phần lớn phản hồi và không trả lời câu hỏi
      // nào về đơn hàng.
      const rows = page.rows ?? [];
      return {
        data: rows,
        total: page.total ?? null,
        summary: page.summary ?? null,
        states: page.states ?? null,
        next_cursor: page.next_cursor ?? null,
        message: pageMessage(page, rows.length, "order item rows"),
      };
    },
  },

  {
    name: "erpnext_merchant_order_get",
    annotations: { readOnlyHint: true },
    description:
      "Read one marketplace order in full, INCLUDING the buyer's name, address and phone, " +
      "plus every item with its row_name, fulfill_stage, tracking_number, label_link, " +
      "design_link and note, and the order's structure_version. Every successful call " +
      "is written to ERP's Sensitive Action Log because it returns buyer personal data, " +
      "so call it only when the buyer details or the full item list are actually needed; " +
      "erpnext_merchant_order_list answers most questions without it. " +
      OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Sales Order name (the 'name' column of erpnext_merchant_order_list)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_order_get";
      const name = requireString(input, "name", tool);
      const doc = await call<Row>(ctx, "get_sales_order", { name }, tool);
      return { data: doc };
    },
  },

  {
    name: "erpnext_merchant_order_comment_list",
    annotations: { readOnlyHint: true },
    description:
      "List the order-level comments on a marketplace order (the discussion thread on " +
      "the Orders page), oldest first, with author, mentions and time. Item notes are " +
      "separate: they are the item_note / note field of each row. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        sales_order: { type: "string", description: "Sales Order name" },
      },
      required: ["sales_order"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_order_comment_list";
      const salesOrder = requireString(input, "sales_order", tool);
      const comments = await call<Row[]>(
        ctx,
        "list_sales_order_comments",
        { sales_order: salesOrder },
        tool,
      );
      return { data: comments };
    },
  },

  {
    name: "erpnext_merchant_order_comment_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Gọi lại là thêm một bình luận thứ hai, và mỗi người được nhắc nhận thêm một thông báo.
      idempotentHint: false,
    },
    description:
      "Post an order-level comment on a marketplace order. 'mentions' takes user emails; " +
      "each mentioned user who can see the order gets a notification, and users who " +
      "cannot are silently left out. Calling twice posts two comments. Returns the " +
      "updated comment list. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        sales_order: { type: "string", description: "Sales Order name" },
        content: { type: "string", description: "Comment text (plain text)" },
        mentions: {
          ...STRING_ARRAY,
          description: "User emails to notify, e.g. ['jane@example.com']",
        },
      },
      required: ["sales_order", "content"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_order_comment_create";
      const salesOrder = requireString(input, "sales_order", tool);
      const content = requireString(input, "content", tool);
      const args: Record<string, unknown> = {
        sales_order: salesOrder,
        content,
      };
      const users: Record<string, unknown> = {};
      copyStringArray(input, users, "mentions", tool);
      if (Array.isArray(users.mentions)) {
        // ERP nhận khuôn `[{user}]` của SPA; tool nhận mảng email cho dễ gọi.
        args.mentions = (users.mentions as string[]).map((user) => ({ user }));
      }
      const comments = await call<Row[]>(
        ctx,
        "add_sales_order_comment",
        args,
        tool,
      );
      // Frappe ghi một `Comment` mới và cập nhật cột `_comments` của chính đơn, nên dọn cả hai.
      ctx.client.invalidate("Comment");
      ctx.client.invalidate("Sales Order", salesOrder);
      return { data: comments, message: `Comment posted on ${salesOrder}` };
    },
  },

  {
    name: "erpnext_merchant_order_item_update",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    description:
      "Update ONE field of ONE item row on a marketplace order. Pass sales_order, " +
      "row_name (from erpnext_merchant_order_list or erpnext_merchant_order_get) and " +
      "exactly one of: note, tracking_number, label_link, design_link, fulfill_stage. " +
      "To change several fields, make one call per field. An empty string clears " +
      "note, tracking_number or label_link. Clearing a tracking number can move the " +
      "item back to an earlier stage, and in whole-order fulfilment tracking_number and " +
      "label_link are copied to the order's other items. fulfill_stage values: " +
      `${FULFILL_STAGE_HINT}. ` +
      "Always pass order_structure (the structure_version you read): ERP then refuses " +
      "the write if the order was split or merged since, instead of writing to a stale " +
      "row. " + OMS_SCOPE,
    category: "oms",
    inputSchema: {
      type: "object",
      properties: {
        sales_order: { type: "string", description: "Sales Order name" },
        row_name: {
          type: "string",
          description: "Sales Order Item row id (row_name)",
        },
        order_structure: {
          type: "string",
          description:
            "structure_version of the order as last read, e.g. 'SO-00012:3f9a...'",
        },
        note: { type: "string", description: "Item note ('' clears it)" },
        tracking_number: {
          type: "string",
          description: "Shipment tracking number ('' clears it)",
        },
        label_link: {
          type: "string",
          description: "Shipping label URL ('' clears it)",
        },
        design_link: {
          type: "object",
          description:
            "The four print design image URLs. All four keys are required; use '' for a " +
            "position with no image. Replaces the whole set.",
          properties: {
            front: { type: "string" },
            back: { type: "string" },
            left: { type: "string" },
            right: { type: "string" },
          },
          required: ["front", "back", "left", "right"],
        },
        fulfill_stage: {
          type: "string",
          description: `New fulfill stage. Values: ${FULFILL_STAGE_HINT}`,
        },
      },
      required: ["sales_order", "row_name"],
    },
    handler: async (input, ctx) => {
      const tool = "erpnext_merchant_order_item_update";
      const salesOrder = requireString(input, "sales_order", tool);
      const rowName = requireString(input, "row_name", tool);
      // Đúng một field mỗi lượt: năm wrapper là năm request riêng, không chung transaction, nên
      // gửi nhiều field mà một lượt giữa chừng hỏng là dòng hàng bị ghi dở dang.
      const given = Object.keys(ITEM_FIELDS).filter(
        (field) => input[field] !== undefined && input[field] !== null,
      );
      if (given.length !== 1) {
        throw new Error(
          `[${tool}] pass exactly one of ${
            Object.keys(ITEM_FIELDS).join(", ")
          }` +
            (given.length > 1 ? ` (got ${given.join(", ")})` : ""),
        );
      }
      const field = given[0];
      const target = ITEM_FIELDS[field];
      let value: string;
      if (field === "design_link") {
        value = joinDesignLinks(input.design_link, tool);
      } else if (typeof input[field] === "string") {
        value = input[field] as string;
      } else {
        throw new Error(`[${tool}] '${field}' must be a string`);
      }
      const args: Record<string, unknown> = {
        sales_order: salesOrder,
        row_name: rowName,
        [target.arg]: value,
      };
      copyString(input, args, "order_structure", tool);
      const result = await call<Row>(ctx, target.fn, args, tool);
      // Dòng hàng là bảng con: đọc qua đơn cha (`erpnext_sales_order_get`) hoặc thẳng qua
      // doctype con (`erpnext_doc_list`), nên dọn cả hai khoá.
      ctx.client.invalidate("Sales Order", salesOrder);
      ctx.client.invalidate("Sales Order Item", rowName);
      return {
        data: result,
        message: `Updated ${field} on ${salesOrder} row ${rowName}`,
      };
    },
  },
];
