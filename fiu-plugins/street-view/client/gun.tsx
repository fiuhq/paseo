import type { Ref } from "react";
import { View } from "react-native";
import type { Theme } from "./city-data";

/**
 * A double-barrelled shotgun held low in the middle of the view, Doom style. The frame loop bobs it
 * while walking, kicks it on a shot and lights the muzzle flash, through `gun` and `flash`.
 */
export function Gun({ theme, gun, flash }: { theme: Theme; gun: Ref<View>; flash: Ref<View> }) {
  const metal = theme.colors.foreground;
  const wood = theme.colors.foregroundMuted;
  return (
    <View
      ref={gun}
      testID="street-view-gun"
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: -30,
        left: "50%",
        width: 240,
        height: 300,
        marginLeft: -120,
      }}
    >
      <View
        ref={flash}
        style={{
          position: "absolute",
          top: -90,
          left: 50,
          width: 140,
          height: 140,
          borderRadius: 70,
          backgroundColor: theme.colors.statusWarning,
          opacity: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: 70,
            height: 70,
            borderRadius: 35,
            backgroundColor: theme.colors.accentForeground,
          }}
        />
      </View>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 82,
          width: 36,
          height: 230,
          borderRadius: 10,
          backgroundColor: metal,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 122,
          width: 36,
          height: 230,
          borderRadius: 10,
          backgroundColor: metal,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 6,
          left: 92,
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: theme.colors.surface0,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 6,
          left: 132,
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: theme.colors.surface0,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 120,
          left: 64,
          width: 112,
          height: 80,
          borderRadius: 14,
          backgroundColor: wood,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 200,
          left: 40,
          width: 160,
          height: 120,
          borderRadius: 30,
          backgroundColor: wood,
        }}
      />
    </View>
  );
}

/** A plus in the middle of the view: what a shot or Space hits. It flares on a hit. */
export function Crosshair({ theme, mark }: { theme: Theme; mark: Ref<View> }) {
  return (
    <View
      ref={mark}
      testID="street-view-crosshair"
      pointerEvents="none"
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: 24,
        height: 24,
        marginTop: -12,
        marginLeft: -12,
      }}
    >
      <View
        style={{
          position: "absolute",
          top: 11,
          left: 0,
          width: 24,
          height: 2,
          backgroundColor: theme.colors.accent,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 11,
          width: 2,
          height: 24,
          backgroundColor: theme.colors.accent,
        }}
      />
    </View>
  );
}
