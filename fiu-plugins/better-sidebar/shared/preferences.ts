import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Which workspaces show their agents. Kept per device: an open tree is a layout choice, not shared data. */
export const layout = defineSettings({
  id: "layout",
  scope: "device",
  version: 1,
  schema: z.object({ expanded: z.array(z.string()).default([]) }),
});
