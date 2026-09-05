/** Chi tiết mặt hàng, chuyển động gần đây và điều hướng theo dòng kho đang chọn. */

import { useEffect, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { colors, fonts, styles } from "~/shared/theme";
import { InfoField } from "~/shared/InfoField";
import { ActionButton } from "~/shared/ActionButton";
import { loadStockDetails } from "~/shared/stock-movements";
import type { StockDetailsState } from "~/shared/stock-movements";

const TOOL_CALL_TIMEOUT_MS = 10_000;

export function StockDetailPanel({ app, itemCode, warehouse, onClose }: {
  app: App;
  itemCode: string;
  warehouse: string;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<
    { identity: string; state: StockDetailsState } | null
  >(null);
  const identity = JSON.stringify([itemCode, warehouse]);

  useEffect(() => {
    let cancelled = false;
    void loadStockDetails(
      (request) =>
        app.callServerTool(request, { timeout: TOOL_CALL_TIMEOUT_MS }),
      itemCode,
      warehouse,
      () => !cancelled,
      (state) => setDetails({ identity, state }),
    );
    return () => {
      cancelled = true;
    };
  }, [app, itemCode, warehouse, identity]);

  if (!details || details.identity !== identity || details.state.itemLoading) {
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

  const { itemData, movements, itemError, movementsError, movementsLoading } =
    details.state;

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
      {itemError && (
        <div role="alert" style={{ color: colors.error, marginBottom: 10 }}>
          Item: {itemError}
        </div>
      )}
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
      {movementsLoading && (
        <div
          role="status"
          style={{ color: colors.text.muted, marginBottom: 10 }}
        >
          Loading recent movements…
        </div>
      )}
      {movementsError && (
        <div role="alert" style={{ color: colors.error, marginBottom: 10 }}>
          {movementsError}
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
