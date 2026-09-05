/** Inline detail panel for a stock line — shows item info, recent movements, and navigation */

import { useEffect, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { colors, fonts, styles } from "~/shared/theme";
import { InfoField } from "~/shared/InfoField";
import { ActionButton } from "~/shared/ActionButton";
import { extractToolResultText } from "~/shared/refresh";
import {
  buildStockMovementsRequest,
  parseStockMovements,
} from "~/shared/stock-movements";
import type { StockMovement } from "~/shared/stock-movements";

const TOOL_CALL_TIMEOUT_MS = 10_000;

export function StockDetailPanel({ app, itemCode, warehouse, onClose }: {
  app: App;
  itemCode: string;
  warehouse: string;
  onClose: () => void;
}) {
  const [itemData, setItemData] = useState<Record<string, unknown> | null>(
    null,
  );
  const [movements, setMovements] = useState<StockMovement[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const identity = JSON.stringify([itemCode, warehouse]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItemData(null);
    setMovements(null);
    setError(null);
    (async () => {
      try {
        const request = buildStockMovementsRequest(itemCode, warehouse);
        const [itemRes, moveRes] = await Promise.all([
          app.callServerTool({
            name: "erpnext_item_get",
            arguments: { name: itemCode },
          }, { timeout: TOOL_CALL_TIMEOUT_MS }),
          app.callServerTool({
            name: request.toolName,
            arguments: request.arguments,
          }, { timeout: TOOL_CALL_TIMEOUT_MS }),
        ]);
        if (cancelled) return;
        setMovements(parseStockMovements(moveRes, itemCode, warehouse));
        if (itemRes.isError) {
          throw new Error(
            extractToolResultText(itemRes) || "Item request failed",
          );
        } else {
          const t = extractToolResultText(itemRes);
          if (t) {
            const p = JSON.parse(t);
            setItemData(p.data ?? p);
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Stock details request failed",
          );
        }
      }
      if (!cancelled) {
        setLoadedIdentity(identity);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, itemCode, warehouse, identity]);

  if (loading || loadedIdentity !== identity) {
    return (
      <div
        style={{
          padding: 16,
          background: colors.bg.surface,
          borderTop: `2px solid ${colors.accent}`,
        }}
      >
        {[1, 2].map((i) => (
          <div
            key={i}
            className="skeleton"
            style={{ height: 14, width: `${30 + i * 15}%`, marginBottom: 8 }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 16,
        background: colors.bg.surface,
        borderTop: `2px solid ${colors.accent}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: colors.text.primary,
              fontFamily: fonts.mono,
            }}
          >
            {itemCode}
          </span>
          <span style={{ fontSize: 11, color: colors.text.muted }}>
            {warehouse}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ ...styles.button, padding: "2px 8px", fontSize: 11 }}
        >
          ✕
        </button>
      </div>

      {/* Item info */}
      {itemData && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 6,
            marginBottom: 10,
          }}
        >
          {typeof itemData.item_name === "string" &&
            itemData.item_name !== "" && (
            <InfoField label="Name" value={String(itemData.item_name)} />
          )}
          {typeof itemData.item_group === "string" &&
            itemData.item_group !== "" && (
            <InfoField label="Group" value={String(itemData.item_group)} />
          )}
          {typeof itemData.stock_uom === "string" &&
            itemData.stock_uom !== "" && (
            <InfoField label="UOM" value={String(itemData.stock_uom)} />
          )}
          {itemData.standard_rate != null && (
            <InfoField
              label="Std Rate"
              value={String(itemData.standard_rate)}
              bold
            />
          )}
        </div>
      )}

      {/* Recent movements */}
      {error && (
        <div role="alert" style={{ color: colors.error, marginBottom: 10 }}>
          {error}
        </div>
      )}
      {movements?.length === 0 && (
        <div style={{ color: colors.text.muted, marginBottom: 10 }}>
          No recent movements for this item and warehouse.
        </div>
      )}
      {movements && movements.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 10,
              color: colors.text.muted,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              marginBottom: 6,
            }}
          >
            Recent Movements
          </div>
          {movements.map((m) => (
            <div
              key={m.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                borderBottom: `1px solid ${colors.borderSubtle}`,
                fontSize: 12,
              }}
            >
              <span style={{ color: colors.text.secondary }}>
                {m.voucher_type} {m.voucher_no}
              </span>
              <span
                style={{ fontFamily: fonts.mono, color: colors.text.primary }}
              >
                {m.posting_date} {m.posting_time}
              </span>
              <span>
                {m.actual_qty > 0 ? "+" : ""}
                {m.actual_qty} {m.stock_uom}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Navigation */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          paddingTop: 8,
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <ActionButton
          label="Stock chart"
          onClick={async () => {
            try {
              await app.sendMessage({
                role: "user",
                content: [{
                  type: "text",
                  text: `Show stock chart for item ${itemCode}`,
                }],
              });
            } catch {}
          }}
        />
        <ActionButton
          label="Item details"
          onClick={async () => {
            try {
              await app.sendMessage({
                role: "user",
                content: [{
                  type: "text",
                  text: `Show me the full details of Item ${itemCode}`,
                }],
              });
            } catch {}
          }}
        />
        <ActionButton
          label="Stock entries"
          onClick={async () => {
            try {
              await app.sendMessage({
                role: "user",
                content: [{
                  type: "text",
                  text: `Show stock entries for item ${itemCode}`,
                }],
              });
            } catch {}
          }}
        />
      </div>
    </div>
  );
}
