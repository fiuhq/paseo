/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceTitleState } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { CompactWorkspaceHeader } from "./index";

void testI18n;

const { mockTheme } = vi.hoisted(() => ({
  mockTheme: {
    colors: {
      foreground: "rgb(1, 1, 1)",
      foregroundMuted: "rgb(2, 2, 2)",
      border: "#000",
      surface1: "#000",
      surface3: "#000",
    },
    spacing: { 1.5: 6, 2: 8, 3: 12 },
    fontSize: { sm: 12, base: 14, lg: 16 },
    fontWeight: { medium: "500" },
    borderRadius: { full: 999 },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory(mockTheme) },
  withUnistyles: (Component: React.ComponentType) => Component,
}));
vi.mock("lucide-react-native", () => ({ ArrowLeft: () => null }));
vi.mock("expo-router", () => ({ router: { back: () => {} } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
vi.mock("@/components/headers/sidebar-menu-toggle", () => ({ SidebarMenuToggle: () => null }));
vi.mock("@/components/headers/header-toggle-button", () => ({ HeaderToggleButton: () => null }));
vi.mock("@/components/ui/icon-button-chrome", () => ({
  IconButtonChromeProvider: ({ children }: { children: React.ReactNode }) => children,
  iconButtonChromeGlyphSize: () => 16,
  mutedIconColorMapping: () => ({}),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children: React.ReactNode; testID: string }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  ),
}));
vi.mock("@/workspace-rename", () => ({ WorkspaceRenameModal: () => null }));
vi.mock("@/screens/workspace/workspace-explorer-toggle", () => ({
  EXPLORER_TOGGLE_KEYS: [],
  WorkspaceExplorerToggle: () => null,
}));
vi.mock("@/screens/workspace/workspace-header-project-row", () => ({
  WorkspaceHeaderProjectRow: ({ subtitle }: { subtitle: string }) => <span>{subtitle}</span>,
}));
vi.mock("./tab-switcher", () => ({ MobileWorkspaceTabSwitcher: () => null }));
vi.mock("@/window-layout", () => ({
  useWindowLayout: () => ({}),
  useTopBand: () => null,
  resolveWorkspaceActionPlacement: () => "header",
  resolveWorkspaceBarActions: () => [],
  WindowLayoutActions: () => null,
}));

const HEADER_PROPS = {
  serverId: "server-1",
  isLoading: false,
  title: "Naming…",
  subtitle: "Paseo",
  isSubtitleDistinct: true,
  onToggleExplorer: () => {},
  explorerToggleLabel: "Explorer",
  explorerToggleAccessibilityState: { expanded: false },
  tabSwitcher: null,
  headerVariant: "compact",
  actionsActive: true,
  children: null,
} as const;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderHeader(titleState: WorkspaceTitleState | null): HTMLElement {
  const props = {
    ...HEADER_PROPS,
    workspace: {
      id: "workspace-1",
      name: "wretched-wombat",
      title: null,
      titleState,
    } as unknown as WorkspaceDescriptor,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<CompactWorkspaceHeader {...props} />));
  return container;
}

const held = (status: WorkspaceTitleState["status"]): WorkspaceTitleState => ({
  status,
  attempts: 3,
  refusedTitle: null,
  score: null,
  judge: "Jev",
});

function titleColor(view: HTMLElement): string {
  const title = view.querySelector('[data-testid="workspace-header-title"]');
  return title ? getComputedStyle(title).color : "";
}

describe("CompactWorkspaceHeader title state", () => {
  it("gives a workspace that ran out of tries its reason, a muted title and Rename", () => {
    const view = renderHeader(held("exhausted"));

    expect(view.querySelector('[data-testid="workspace-title-state"]')?.textContent).toContain("3");
    expect(view.querySelector('[data-testid="workspace-title-rename"]')).not.toBeNull();
    expect(titleColor(view)).toBe("rgb(2, 2, 2)");
    expect(view.textContent).toContain("Paseo");
  });

  it("says a title is the best of refused tries, with its score and Rename, without muting it", () => {
    const view = renderHeader({ ...held("unchecked"), score: 0.62 });

    const chip = view.querySelector('[data-testid="workspace-title-state"]')?.textContent;
    expect(chip).toContain("0.62");
    expect(chip).toContain("3");
    expect(view.querySelector('[data-testid="workspace-title-rename"]')).not.toBeNull();
    expect(titleColor(view)).toBe("rgb(1, 1, 1)");
  });

  it("says a title went on unchecked, without muting it", () => {
    const view = renderHeader(held("unchecked"));

    expect(view.querySelector('[data-testid="workspace-title-state"]')?.textContent).toContain(
      "Jev",
    );
    expect(view.querySelector('[data-testid="workspace-title-rename"]')).toBeNull();
    expect(titleColor(view)).toBe("rgb(1, 1, 1)");
  });

  it("adds nothing to a workspace with no title state", () => {
    const view = renderHeader(null);

    expect(view.querySelector('[data-testid="workspace-title-state"]')).toBeNull();
    expect(titleColor(view)).toBe("rgb(1, 1, 1)");
  });
});
