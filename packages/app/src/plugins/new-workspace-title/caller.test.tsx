import React, { Component as ClassComponent, memo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginNewWorkspaceTitleProps } from "@getpaseo/plugin/client";
import { titleCallerFor } from "./caller";

const props = {} as PluginNewWorkspaceTitleProps;

function draw(Title: React.ComponentType<PluginNewWorkspaceTitleProps>): string {
  const Caller = titleCallerFor(Title);
  return renderToStaticMarkup(
    <Caller titleProps={props}>
      <b>New workspace</b>
    </Caller>,
  );
}

describe("titleCallerFor", () => {
  it("draws the plugin title in place of the default", () => {
    function Quote() {
      const [text] = useState("Be more ambitious");
      return <i>{text}</i>;
    }
    expect(draw(Quote)).toBe("<i>Be more ambitious</i>");
  });

  it("shows the default title when the plugin title renders nothing", () => {
    expect(draw(() => null)).toBe("<b>New workspace</b>");
    expect(draw(() => false)).toBe("<b>New workspace</b>");
  });

  it("gives each title component its own caller", () => {
    function Title() {
      return null;
    }
    expect(titleCallerFor(Title)).toBe(titleCallerFor(Title));
    expect(titleCallerFor(Title)).not.toBe(titleCallerFor(() => null));
  });

  it("mounts a memo or class title as a child", () => {
    class Legacy extends ClassComponent<PluginNewWorkspaceTitleProps> {
      render() {
        return <i>class</i>;
      }
    }
    expect(draw(memo(() => <i>memo</i>))).toBe("<i>memo</i>");
    expect(draw(Legacy)).toBe("<i>class</i>");
  });
});
