import type { ComponentType, ReactNode } from "react";
import type { PluginNewWorkspaceTitleProps } from "@getpaseo/plugin/client";

export interface TitleCallerProps {
  titleProps: PluginNewWorkspaceTitleProps;
  /** The default title, shown when the plugin title renders nothing. */
  children: ReactNode;
}

type TitleComponent = ComponentType<PluginNewWorkspaceTitleProps>;

const callers = new WeakMap<TitleComponent, ComponentType<TitleCallerProps>>();

function isFunctionComponent(
  Component: TitleComponent,
): Component is (props: PluginNewWorkspaceTitleProps) => ReactNode {
  return typeof Component === "function" && !Component.prototype?.isReactComponent;
}

/**
 * The component that draws one plugin title, or the default title when it renders nothing.
 *
 * React cannot tell that a mounted child rendered `null`, so the caller runs a function component
 * itself and reads the result; the title's hooks run as the caller's. Each title component gets its
 * own caller type, so a reloaded plugin remounts instead of replaying one component's hooks in
 * another. A class, `memo` or `forwardRef` title mounts as a child and cannot fall back.
 */
export function titleCallerFor(Component: TitleComponent): ComponentType<TitleCallerProps> {
  const existing = callers.get(Component);
  if (existing) return existing;
  const caller = isFunctionComponent(Component)
    ? function PluginNewWorkspaceTitleCaller({ titleProps, children }: TitleCallerProps) {
        "use no memo"; // The compiler must not cache the call: the title's hooks run on every render.
        const drawn = Component(titleProps);
        return drawn === null || drawn === undefined || drawn === false ? children : drawn;
      }
    : function PluginNewWorkspaceTitleMount({ titleProps }: TitleCallerProps) {
        return <Component {...titleProps} />;
      };
  callers.set(Component, caller);
  return caller;
}
