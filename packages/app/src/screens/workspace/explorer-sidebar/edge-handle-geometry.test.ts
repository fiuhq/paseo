import { describe, expect, it } from "vitest";
import {
  clampEdgeHandleOffset,
  dragEdgeHandleOffset,
  EDGE_HANDLE_DEFAULT_OFFSET,
  EDGE_HANDLE_HEIGHT,
  edgeHandleTop,
} from "./edge-handle-geometry";

describe("Explorer edge handle geometry", () => {
  it("keeps a stored offset on the column and falls back to the middle for an unreadable one", () => {
    expect(clampEdgeHandleOffset(0.3)).toBe(0.3);
    expect(clampEdgeHandleOffset(-2)).toBe(0.05);
    expect(clampEdgeHandleOffset(7)).toBe(0.95);
    expect(clampEdgeHandleOffset(Number.NaN)).toBe(EDGE_HANDLE_DEFAULT_OFFSET);
  });

  it("moves by the dragged distance as a share of the column height", () => {
    expect(dragEdgeHandleOffset(0.5, -200, 1000)).toBeCloseTo(0.3);
    expect(dragEdgeHandleOffset(0.5, 100, 1000)).toBeCloseTo(0.6);
    expect(dragEdgeHandleOffset(0.5, 5000, 1000)).toBe(0.95);
  });

  it("does not move before the column has a height", () => {
    expect(dragEdgeHandleOffset(0.4, 120, 0)).toBe(0.4);
  });

  it("centres the handle on its offset without letting it leave the column", () => {
    expect(edgeHandleTop(0.5, 1000)).toBe(500 - EDGE_HANDLE_HEIGHT / 2);
    expect(edgeHandleTop(0.05, 300)).toBe(0);
    expect(edgeHandleTop(0.95, 300)).toBe(300 - EDGE_HANDLE_HEIGHT);
    expect(edgeHandleTop(0.5, 20)).toBe(0);
  });
});
