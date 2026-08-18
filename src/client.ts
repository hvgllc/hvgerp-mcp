/**
 * ErpNext Tools Client
 *
 * Client for executing ERPNext tools with MCP interface support.
 * Follows the same pattern as lib/syson/src/client.ts and lib/plm/src/client.ts.
 *
 * @module lib/erpnext/src/client
 */

import {
  allTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./tools/mod.ts";
import type {
  ErpNextTool,
  ErpNextToolCategory,
  ToolAnnotations,
} from "./tools/types.ts";
import type {
  MCPToolMeta,
  ToolHandler,
  ToolHandlerContext,
} from "@casys/mcp-server";
import { getFrappeClient } from "./api/frappe-client.ts";
import { runWithLinkDisambiguation } from "./mrtr/link-disambiguation.ts";
import { withUiRefreshRequest } from "./tools/ui-refresh.ts";
import {
  readViewerResourceUri,
  withoutViewerBinding,
} from "./tools/viewer-meta.ts";

// Re-export from tools
export {
  allTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
};

export type { ErpNextTool, ErpNextToolCategory };

// ============================================================================
// Wire format types (MCP protocol)
// ============================================================================

/** Minimal JSON Schema representation used for MCP tool input validation. */
export interface JSONSchema {
  /** JSON Schema type, e.g. "object", "string", "number", "array", "boolean" */
  type: string;
  /** Nested property schemas (for type "object") */
  properties?: Record<string, JSONSchema>;
  /** List of required property names */
  required?: string[];
  /** Human-readable description of the schema or property */
  description?: string;
  /** Additional JSON Schema keywords (e.g. `enum`, `items`, `default`) */
  [key: string]: unknown;
}

export type { ToolAnnotations } from "./tools/types.ts";

/** MCP protocol wire format for tool registration. Sent to MCP clients during `tools/list`. */
export interface MCPToolWireFormat {
  /** Unique tool name, e.g. "erpnext_list_customers" */
  name: string;
  /** Human-readable tool description shown to LLM / MCP client */
  description: string;
  /** JSON Schema defining the tool's input parameters */
  inputSchema: JSONSchema;
  /** Behavioural hints for model clients */
  annotations?: ToolAnnotations;
  /** Optional MCP metadata for UI rendering (e.g. iframe viewer resource URI) */
  _meta?: MCPToolMeta;
}

// ============================================================================
// ErpNextToolsClient Class
// ============================================================================

/** Tool phân giải "me", nạp kèm mọi bộ lọc category. Xem hàm dựng bên dưới. */
const WHOAMI_TOOL_NAME = "erpnext_whoami";

/** Configuration options for {@link ErpNextToolsClient}. */
export interface ErpNextToolsClientOptions {
  /** Restrict tools to specific categories (e.g. `["selling", "stock"]`). Omit to load all. */
  categories?: string[];
  /** Enable MRTR forms for ambiguous Link-field resolution. Default: false. */
  enableLinkDisambiguation?: boolean;
  /**
   * The `ui://` resource URIs the host process actually registers.
   *
   * Tool metadata binds viewers statically, but the viewer bundles are built
   * separately and any of them can be missing — a skipped `deno task ui:build`
   * leaves none, and `src/ui/build-all.mjs` exits on the first failure after
   * writing the viewers it already finished, leaving some. Passing the real set
   * lets every binding to an unregistered viewer be dropped instead of shipped,
   * so a host is never told to load a resource this process cannot serve.
   *
   * Omit to keep every binding as authored. That is the right default for a
   * library consumer, which registers its own resources and is the only party
   * that knows which ones exist.
   */
  servableViewerUris?: readonly string[];
}

/**
 * Client for executing ERPNext tools.
 * Lazily initializes the Frappe HTTP client on first tool execution.
 */
export class ErpNextToolsClient {
  private tools: ErpNextTool[];
  private readonly enableLinkDisambiguation: boolean;
  /** `null` means the caller did not say, so every binding is kept as authored. */
  private readonly servableViewerUris: ReadonlySet<string> | null;

  constructor(options?: ErpNextToolsClientOptions) {
    this.enableLinkDisambiguation = options?.enableLinkDisambiguation ?? false;
    this.servableViewerUris = options?.servableViewerUris
      ? new Set(options.servableViewerUris)
      : null;
    if (options?.categories) {
      // `erpnext_whoami` được nạp kể cả khi người gọi không xin category `identity`. Nó không
      // phải một mảng nghiệp vụ như `sales` hay `hr`: nó là tool DUY NHẤT dịch "my"/"me" thành
      // một ID `User`, và chỉ dẫn của máy chủ bảo mô hình gọi nó trước mọi yêu cầu ngôi thứ nhất.
      // Tôn trọng `--categories=project` theo nghĩa đen sẽ để chỉ dẫn đó trỏ vào một tool vắng
      // mặt trong `tools/list`, nên `erpnext_task_list({assigned_to: "me"})` - lời gọi mà chính
      // category được chọn có hỗ trợ - không có cách nào phân giải chủ ngữ của nó.
      //
      // Thêm ĐÚNG một tool, không phải cả category: `erpnext_my_work` cũng nằm trong `identity`
      // và nó đọc ToDo, Leave Application, Expense Claim, Timesheet. Kéo cả category vào thì
      // `--categories=project` lặng lẽ mở ra bốn doctype ngoài phạm vi vừa xin, và bộ lọc
      // category thôi không còn là cái chặn bề mặt nghiệp vụ nữa.
      const selected = options.categories.flatMap((cat) =>
        getToolsByCategory(cat)
      );
      const whoami = getToolByName(WHOAMI_TOOL_NAME);
      this.tools = whoami && !selected.some((t) => t.name === WHOAMI_TOOL_NAME)
        ? [whoami, ...selected]
        : selected;
    } else {
      this.tools = allTools;
    }
  }

  /** List available tools (with handler attached) */
  listTools(): ErpNextTool[] {
    return this.tools;
  }

  /**
   * `meta`, minus any viewer binding the host cannot serve.
   *
   * Returns `meta` untouched when the caller passed no `servableViewerUris` (it
   * did not tell us what it serves, so we do not overrule it) or when the
   * binding resolves to a registered viewer.
   */
  private servableMeta<T extends MCPToolMeta>(meta: T): T | undefined {
    if (!this.servableViewerUris) return meta;
    const uri = readViewerResourceUri(meta as Record<string, unknown>);
    if (uri === null || this.servableViewerUris.has(uri)) return meta;
    return withoutViewerBinding(meta as Record<string, unknown>) as
      | T
      | undefined;
  }

  /** Convert tools to MCP wire format (for server registration) */
  toMCPFormat(): MCPToolWireFormat[] {
    return this.tools.map((t) => {
      const wire: MCPToolWireFormat = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as JSONSchema,
      };
      if (t.annotations) wire.annotations = t.annotations;
      if (t._meta) {
        const meta = this.servableMeta(t._meta);
        if (meta) wire._meta = meta;
      }
      return wire;
    });
  }

  /**
   * Build a handlers Map for McpApp.registerTools().
   * Each handler wraps the tool to inject the FrappeClient context.
   * Errors are handled by the server's toolErrorMapper (configured in server.ts).
   *
   * For viewer tools (result has _meta.ui), the return value is a pre-formatted
   * MCP result with both `content` (text JSON for LLM) and `structuredContent`
   * (object for the UI viewer). McpApp passes pre-formatted results
   * through unchanged.
   */
  buildHandlersMap(): Map<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    for (const tool of this.tools) {
      const toolMeta = tool._meta ? this.servableMeta(tool._meta) : undefined;
      handlers.set(tool.name, async (
        args: Record<string, unknown>,
        mcpContext?: ToolHandlerContext,
      ) => {
        const client = getFrappeClient();
        const toolContext = {
          client,
          ...(mcpContext?.clientCapabilities !== undefined
            ? { clientCapabilities: mcpContext.clientCapabilities }
            : {}),
          ...(mcpContext?.inputResponses !== undefined
            ? { inputResponses: mcpContext.inputResponses }
            : {}),
          ...(mcpContext?.retryVerified !== undefined
            ? { retryVerified: mcpContext.retryVerified }
            : {}),
        };
        const execution = this.enableLinkDisambiguation
          ? await runWithLinkDisambiguation({
            args,
            context: mcpContext,
            enabled: true,
            execute: (callArgs) => tool.handler(callArgs, toolContext),
          })
          : {
            result: await tool.handler(args, toolContext),
            args,
          };
        if (
          execution.result !== null &&
          typeof execution.result === "object" &&
          !Array.isArray(execution.result) &&
          (execution.result as Record<string, unknown>).resultType ===
            "input_required"
        ) {
          return execution.result;
        }
        const result = withUiRefreshRequest(
          execution.result,
          tool.name,
          execution.args,
        );

        // For viewer tools, return a pre-formatted MCP result so the server
        // passes it through intact. Viewers receive structuredContent directly;
        // LLMs receive the same data as a JSON text string in content.
        // Check both result._meta.ui (list tools embed it) and tool._meta.ui (get tools don't).
        const r = result !== null && typeof result === "object" &&
            !Array.isArray(result)
          ? result as Record<string, unknown>
          : null;
        const resultUi = r?._meta && typeof r._meta === "object" &&
          (r._meta as Record<string, unknown>).ui;
        const hasViewer = resultUi || toolMeta?.ui;

        if (r && hasViewer) {
          // Binding của payload (do `listResult()` đóng dấu) đi qua đúng bộ lọc mà binding của
          // định nghĩa tool đã đi qua. Bỏ sót đường này là bỏ sót phần lớn tool có viewer: với
          // tool danh sách, `_meta` của payload thắng `toolMeta`, nên lọc mỗi `toolMeta` sẽ để
          // nguyên binding trên chính lời gọi mà host dùng để quyết định render.
          const envelopeMeta = this.servableMeta(
            (r._meta ?? toolMeta) as MCPToolMeta,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: r,
            ...(envelopeMeta ? { _meta: envelopeMeta } : {}),
          };
        }

        return result;
      });
    }
    return handlers;
  }

  /** Execute a tool by name */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(
        `[ErpNextToolsClient] Unknown tool: "${name}". ` +
          `Available: ${this.tools.map((t) => t.name).join(", ")}`,
      );
    }
    const client = getFrappeClient();
    const result = await tool.handler(args, { client });
    return withUiRefreshRequest(result, tool.name, args);
  }

  /** Get tool count */
  get count(): number {
    return this.tools.length;
  }
}

/** Default singleton client (all categories) */
export const defaultClient: ErpNextToolsClient = new ErpNextToolsClient();
