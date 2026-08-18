/**
 * Havi Group Brand Components
 *
 * Header bar and footer watermark for the MCP Apps viewers.
 *
 * The mark, wordmark and tagline mirror the Havi Group Workspace SPA sidebar
 * (HaviGroupERP repo, `apps/hvg_workspace/frontend/src/components/Sidebar.vue`
 * lines 117-133): an accent-filled rounded square holding a white "H", the
 * "Havi Group" wordmark, and the "ERP · OPERATIONS" eyebrow. Colours come from
 * `global.css`, which carries the same tokens as the SPA.
 */

import { CSSProperties } from "react";
import { colors, fonts } from "./theme";

/** Accent square with a white "H" — the SPA sidebar mark, scaled to 18px. */
function HaviGroupMark() {
  const markStyle: CSSProperties = {
    width: 18,
    height: 18,
    flexShrink: 0,
    borderRadius: 5,
    background: colors.accent,
    color: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1,
  };

  return (
    <div style={markStyle} aria-hidden="true">
      H
    </div>
  );
}

export function ErpNextBrandHeader() {
  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "0 14px",
    height: 30,
    background: colors.bg.surface,
    borderBottom: `1px solid ${colors.border}`,
    flexShrink: 0,
  };

  const wordmarkStyle: CSSProperties = {
    fontFamily: fonts.sans,
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    color: colors.text.primary,
  };

  const dotStyle: CSSProperties = {
    width: 3,
    height: 3,
    borderRadius: "50%",
    background: colors.text.faint,
    marginLeft: 2,
    marginRight: 2,
    flexShrink: 0,
  };

  // `text.faint` is for decoration only (the separator dot above). This eyebrow
  // is read, and at 9.5px it falls under the 4.5:1 AA threshold for normal text,
  // so it stays on `text.muted` (#676F7D — 4.72:1 on the header's `bg.surface`).
  const taglineStyle: CSSProperties = {
    fontFamily: fonts.sans,
    fontSize: 9.5,
    fontWeight: 600,
    color: colors.text.muted,
    letterSpacing: "0.13em",
  };

  return (
    <div style={headerStyle}>
      <HaviGroupMark />
      <span style={wordmarkStyle}>Havi Group</span>
      <div style={dotStyle} />
      <span style={taglineStyle}>ERP · OPERATIONS</span>
    </div>
  );
}

export function ErpNextBrandFooter() {
  const footerStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    padding: "6px 16px 8px",
    borderTop: `1px solid ${colors.borderSubtle}`,
    marginTop: 8,
  };

  const textStyle: CSSProperties = {
    fontFamily: fonts.sans,
    fontSize: 10,
    color: colors.text.faint,
    letterSpacing: "0.04em",
  };

  return (
    <div style={footerStyle}>
      <span style={textStyle}>Havi Group ERP</span>
    </div>
  );
}
