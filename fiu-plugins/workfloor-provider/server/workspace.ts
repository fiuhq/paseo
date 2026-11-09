import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { CardCode, CardRef } from "./workfloor.js";

type Paseo = PluginServerContext["paseo"];

/** The workspace metadata key naming the Workfloor card a workspace was made for. */
export const CARD_KEY = "workfloorCard";

/**
 * Where an imported card works in Paseo: a worktree of its repository's Paseo project, checked out
 * on the card's open pull request. The one made before for this card (or any worktree already on
 * that pull request) is reused; a card with no open pull request works in the project's checkout.
 * Undefined when Paseo has no project for the card's repository.
 */
export async function cardWorkspace(
  paseo: Paseo,
  ref: CardRef,
  code: CardCode,
  title: string | undefined,
): Promise<string | undefined> {
  const repo = code.repository?.toLowerCase();
  if (!repo) return undefined;
  const { projects } = await paseo.projects.list();
  const project = projects.find((p) => p.projectKey?.toLowerCase() === `remote:github.com/${repo}`);
  if (!project) return undefined;
  const pr = code.externalItems?.find(
    (item) =>
      item.kind === "pull_request" &&
      item.state === "open" &&
      item.number &&
      (item.repository ?? repo).toLowerCase() === repo,
  )?.number;
  if (!pr) return project.projectRootPath;
  const key = `${ref.project}/${ref.card}`;
  const { entries } = await paseo.workspaces.list();
  const mine = entries.filter((w) => w.projectId === project.projectId && w.workspaceDirectory);
  const existing =
    mine.find((w) => w.metadata?.[CARD_KEY] === key) ??
    mine.find((w) => w.githubRuntime?.pullRequest?.number === pr);
  if (existing?.workspaceDirectory) return existing.workspaceDirectory;
  const created = await paseo.workspaces.create({
    source: {
      kind: "worktree",
      projectId: project.projectId,
      action: "checkout",
      checkoutSource: { kind: "change_request", number: pr },
    },
    ...(title ? { title } : {}),
    metadata: { [CARD_KEY]: key },
  });
  return created.directory ?? undefined;
}
