import { Gauge } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { SvgIcon, useProviderIcon } from "@/components/provider-icons";
import type { Theme } from "@/styles/theme";

function UsageSourceIconBase({
  svg,
  size,
  color = "",
}: {
  svg: string | null;
  size: number;
  color?: string;
}) {
  if (!svg) return <Gauge size={size} color={color} />;
  return <SvgIcon svg={svg} size={size} color={color} />;
}

const ThemedUsageSourceIcon = withUnistyles(UsageSourceIconBase);

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The source's catalog SVG, or a generic gauge when the source ships none. */
export function UsageSourceIcon({ svg, size }: { svg: string | null; size: number }) {
  return <ThemedUsageSourceIcon svg={svg} size={size} uniProps={mutedIconColor} />;
}

const ThemedProviderIcon = withUnistyles(
  ({
    provider,
    serverId,
    size,
    color = "",
  }: {
    provider: string;
    serverId: string;
    size: number;
    color?: string;
  }) => {
    const Icon = useProviderIcon(provider, serverId);
    return <Icon size={size} color={color} />;
  },
);

/** The icon of the provider an account belongs to, for an account that ships no SVG of its own. */
export function UsageProviderIcon({
  provider,
  serverId,
  size,
}: {
  provider: string;
  serverId: string;
  size: number;
}) {
  return (
    <ThemedProviderIcon
      provider={provider}
      serverId={serverId}
      size={size}
      uniProps={mutedIconColor}
    />
  );
}
