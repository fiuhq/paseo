import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { CardRef, CardView } from "./workfloor.js";

type Paseo = PluginServerContext["paseo"];

/** The workspace metadata key naming the Workfloor card a workspace was made for. */
export const CARD_KEY = "workfloorCard";

/** Where a card was put: its directory, and why its worktree was not made when that failed. */
export interface Placement {
  cwd?: string;
  failure?: unknown;
  /** Still being made when the search stopped waiting: a later search finds it. */
  pending?: boolean;
}

/**
 * Where an imported card works in Paseo: its own worktree of its repository's Paseo project, named
 * after the card. A card with an open pull request when first imported is checked out on it; one
 * without branches off the default branch. A card keeps the workspace it was given on later pastes
 * or imports, even once it has a pull request; a card with no workspace yet reuses a worktree
 * already on its pull request. No directory when Paseo has no project for the card's repository. A
 * failure never throws: it leaves the card in the project's checkout when the project was found,
 * and says why.
 */
export async function cardWorkspace(
  paseo: Paseo,
  ref: CardRef,
  card: CardView,
): Promise<Placement> {
  let checkout: string | undefined;
  try {
    const repo = card.repository?.toLowerCase();
    if (!repo) return {};
    const { projects } = await paseo.projects.list();
    const project = projects.find(
      (p) => p.projectKey?.toLowerCase() === `remote:github.com/${repo}`,
    );
    if (!project) return {};
    checkout = project.projectRootPath;
    const pr = card.externalItems?.find(
      (item) =>
        item.kind === "pull_request" &&
        item.state === "open" &&
        item.number &&
        (item.repository ?? repo).toLowerCase() === repo,
    )?.number;
    const key = `${ref.project}/${ref.card}`;
    const mine: Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"] = [];
    for (let cursor: string | undefined; ; ) {
      const { entries, pageInfo } = await paseo.workspaces.list({
        filter: { projectId: project.projectId },
        ...(cursor ? { page: { limit: 200, cursor } } : {}),
      });
      mine.push(...entries.filter((w) => w.workspaceDirectory));
      cursor = pageInfo.nextCursor ?? undefined;
      if (!pageInfo.hasMore || !cursor) break;
    }
    const existing =
      mine.find((w) => w.metadata?.[CARD_KEY] === key) ??
      (pr ? mine.find((w) => w.githubRuntime?.pullRequest?.number === pr) : undefined);
    if (existing?.workspaceDirectory) return { cwd: existing.workspaceDirectory };
    const created = await paseo.workspaces.create({
      source: {
        kind: "worktree",
        projectId: project.projectId,
        ...(pr
          ? { action: "checkout", checkoutSource: { kind: "change_request", number: pr } }
          : {}),
      },
      ...(card.title ? { title: card.title } : {}),
      metadata: { [CARD_KEY]: key },
    });
    return created.directory ? { cwd: created.directory } : {};
  } catch (failure) {
    return { ...(checkout ? { cwd: checkout } : {}), failure };
  }
}
