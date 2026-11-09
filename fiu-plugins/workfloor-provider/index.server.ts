import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createWorkfloorProvider } from "./server/provider.js";
import { connection } from "./shared/settings.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerSettings">,
) {
  const settings = server.registerSettings(connection);
  server.registerProvider(
    createWorkfloorProvider({
      async auth() {
        const read = await settings.read();
        if (read.status !== "ready")
          return { missing: `Workfloor's settings are unreadable: ${read.error}` };
        if (!read.values.token)
          return {
            missing: "Open Settings, Workfloor, and paste a personal token that can read and write",
          };
        return { url: read.values.url.replace(/\/+$/, ""), token: read.values.token };
      },
    }),
  );
  return () => {};
}
