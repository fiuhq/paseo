import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { connection } from "../shared/settings";

type Ready = Extract<SettingsState<typeof connection.schema>, { status: "ready" }>;

function ConnectionForm({
  settings,
  theme,
}: {
  settings: Ready;
  theme: PluginSurfaceProps["theme"];
}) {
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  // A token is shown once by Workfloor and never again here: the field starts empty and only replaces it.
  const [draft, setDraft] = useState({ url: settings.values.url, token: "" });
  const save = useCallback(async () => {
    const token = draft.token.trim() || settings.values.token;
    if (await settings.save({ url: draft.url, token }, settings.revision))
      setDraft((d) => ({ ...d, token: "" }));
  }, [draft, settings]);
  return (
    <SettingsSection title="Workfloor">
      <SettingsCard>
        <SettingsInput
          label="Workfloor address"
          initialValue={draft.url}
          onChangeText={(url: string) => setDraft((d) => ({ ...d, url }))}
          disabled={settings.saving}
        />
        <SettingsInput
          label={
            settings.values.token
              ? "Personal token (saved; paste a new one to replace it)"
              : "Personal token"
          }
          initialValue=""
          secureTextEntry
          onChangeText={(token: string) => setDraft((d) => ({ ...d, token }))}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <SettingsAction
          label="Make one in Workfloor: Settings, Personal tokens, Read and write"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={save}
        />
      </SettingsCard>
      <Text style={style}>
        {settings.values.token ? "Connected with a saved token." : "Not connected yet."}
      </Text>
    </SettingsSection>
  );
}

export function WorkfloorSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(connection);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Workfloor">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Start over" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  return <ConnectionForm settings={settings} theme={theme} />;
}
