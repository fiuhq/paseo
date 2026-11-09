import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Where Workfloor is and the personal token that acts as you there, kept on this host only. */
export const connection = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({
    url: z
      .string()
      .trim()
      .url("Enter Workfloor's address")
      .default("https://flxbl.workfloor.cloud"),
    token: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || value.startsWith("wfpat_"),
        "A personal token starts with wfpat_",
      )
      .default(""),
  }),
});
