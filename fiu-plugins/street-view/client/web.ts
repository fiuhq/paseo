import { Platform, type ViewStyle } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface KeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly target: unknown;
  preventDefault(): void;
}
interface WheelEvent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
  preventDefault(): void;
}
interface MouseEvent {
  readonly movementX: number;
  readonly button: number;
  preventDefault(): void;
}
interface Listening {
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: { passive: boolean },
  ): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
}
interface Element extends Listening {
  readonly parentElement: Element | null;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  getClientRects(): { readonly length: number };
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  contains(other: unknown): boolean;
  requestPointerLock(): unknown;
  readonly style: { [property: string]: string };
}
interface Gain {
  readonly gain: {
    setValueAtTime(value: number, at: number): void;
    exponentialRampToValueAtTime(value: number, at: number): void;
  };
  connect(to: unknown): void;
}
interface Audio {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  createBuffer(
    channels: number,
    length: number,
    rate: number,
  ): { getChannelData(channel: number): Float32Array };
  createBufferSource(): { buffer: unknown; connect(to: unknown): void; start(): void };
  createGain(): Gain;
}
declare const window: Listening & {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  AudioContext?: new () => Audio;
};
declare const document: Listening & {
  readonly pointerLockElement: unknown;
  exitPointerLock(): void;
  elementFromPoint(x: number, y: number): Element | null;
};

/**
 * The street is drawn with CSS 3D transforms on real DOM, so it stays readable and clickable by an
 * agent. React Native has no 3D rendering context, so phones get the 2D map only.
 * ponytail: web-only 3D; a native renderer (expo-gl) if the street is ever wanted on a phone.
 */
export const CAN_3D = Platform.OS === "web";

/** A React Native ref's current value; on the web it is the DOM element. */
export interface NodeRef {
  readonly current: unknown;
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    "getClientRects" in node &&
    "addEventListener" in node &&
    "style" in node
  );
}

function element(node: unknown): Element | null {
  return isElement(node) ? node : null;
}

function shown(node: unknown): boolean {
  const target = element(node);
  return target !== null && target.isConnected && target.getClientRects().length > 0;
}

function typing(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  if ("isContentEditable" in target && target.isContentEditable === true) return true;
  return (
    "tagName" in target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}

/** Degrees turned per pixel a finger moves the captured pointer, and per pixel of sideways swipe. */
const LOOK = 0.18;
const SWIPE_TURN = 0.22;
/** World pixels walked per pixel of two-finger swipe up or down. */
const SWIPE_WALK = 2.2;

export interface Controls {
  /** Keys held now, lower-cased (`w`, `arrowleft`, `shift`, …). */
  readonly held: ReadonlySet<string>;
  /** Turn and walk gathered from the touchpad since the last call, then reset. */
  take(): { readonly turn: number; readonly walk: number };
  /** True while the pointer is captured for look-and-shoot. */
  locked(): boolean;
  /** Capture the pointer: finger movement then looks around and a click fires. */
  capture(): void;
  /** Give the pointer back, e.g. before leaving the screen. */
  release(): void;
  dispose(): void;
}

export interface ControlHandlers {
  onFire(): void;
  onUse(): void;
  /** Any other key; return true if it was used. */
  onKey(key: string): boolean;
  onLockChange(locked: boolean): void;
}

const MOVE_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "shift",
]);

/**
 * First-person input while the screen is on show: held keys, a two-finger touchpad swipe (up and
 * down walks, sideways turns) and, once captured with a click, pointer look with click to fire.
 */
export function controls(root: NodeRef, handlers: ControlHandlers): Controls {
  const held = new Set<string>();
  let turn = 0;
  let walk = 0;
  const none: Controls = {
    held,
    take: () => ({ turn: 0, walk: 0 }),
    locked: () => false,
    capture: () => {},
    release: () => {},
    dispose: () => {},
  };
  if (Platform.OS !== "web") return none;
  const locked = () => {
    const node = element(root.current);
    return node !== null && document.pointerLockElement === node;
  };
  const down = (event: KeyEvent) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      typing(event.target) ||
      !shown(root.current)
    )
      return;
    const key = event.key.toLowerCase();
    if (MOVE_KEYS.has(key)) held.add(key);
    else if (key === "f") handlers.onFire();
    else if (key === " " || key === "e") handlers.onUse();
    else if (!handlers.onKey(event.key)) return;
    event.preventDefault();
  };
  const up = (event: KeyEvent) => {
    held.delete(event.key.toLowerCase());
  };
  const blur = () => held.clear();
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return; // a pinch is the browser's zoom
    event.preventDefault();
    turn += event.deltaX * SWIPE_TURN;
    walk += event.deltaY * SWIPE_WALK;
  };
  const move = (event: MouseEvent) => {
    if (locked()) turn += event.movementX * LOOK;
  };
  const press = (event: MouseEvent) => {
    if (!locked() || event.button !== 0) return;
    event.preventDefault();
    handlers.onFire();
  };
  const lockChange = () => {
    held.clear();
    handlers.onLockChange(locked());
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  document.addEventListener("mousemove", move);
  document.addEventListener("mousedown", press);
  document.addEventListener("pointerlockchange", lockChange);
  const node = element(root.current);
  node?.addEventListener("wheel", wheel, { passive: false });
  return {
    held,
    take() {
      const taken = { turn, walk };
      turn = 0;
      walk = 0;
      return taken;
    },
    locked,
    capture() {
      element(root.current)?.requestPointerLock();
    },
    release() {
      if (locked()) document.exitPointerLock();
    },
    dispose() {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mousedown", press);
      document.removeEventListener("pointerlockchange", lockChange);
      node?.removeEventListener("wheel", wheel);
      if (locked()) document.exitPointerLock();
    },
  };
}

/** Calls `tick` with the seconds since the last frame, every frame, until stopped. */
export function everyFrame(tick: (seconds: number) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  let last = 0;
  let handle = 0;
  const frame = (now: number) => {
    tick(last === 0 ? 0 : (now - last) / 1000);
    last = now;
    handle = window.requestAnimationFrame(frame);
  };
  handle = window.requestAnimationFrame(frame);
  return () => window.cancelAnimationFrame(handle);
}

/** Sets a style on a rendered node directly, for what changes every frame. */
export function setStyle(node: unknown, property: string, value: string): void {
  const target = element(node);
  if (target) target.style[property] = value;
}

/** The `data-testid` of the street element under the crosshair (the centre of `root`), if any. */
export function aimed(root: NodeRef, prefix: string): string | null {
  const node = element(root.current);
  if (!node) return null;
  const box = node.getBoundingClientRect();
  let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  while (hit && node.contains(hit)) {
    const id = hit.getAttribute("data-testid");
    if (id?.startsWith(prefix)) return id;
    hit = hit.parentElement;
  }
  return null;
}

let audio: Audio | null = null;

/** A shotgun blast: a short burst of noise that falls away. Silent where the browser has no audio. */
export function bang(): void {
  if (Platform.OS !== "web" || !window.AudioContext) return;
  audio ??= new window.AudioContext();
  const length = Math.floor(audio.sampleRate * 0.35);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.6, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audio.currentTime + 0.35);
  source.connect(gain);
  gain.connect(audio.destination);
  source.start();
}

/** The viewport: the eye stands `perspective` px in front of the screen. */
export function viewport(perspective: number): ViewStyle {
  const style = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
    perspective: `${perspective}px`,
  } as const;
  return style;
}

/** A zero-size origin at the viewport's centre whose children share one 3D space; the eye moves it every frame. */
export function space(): ViewStyle {
  const style = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 0,
    height: 0,
    transformStyle: "preserve-3d",
  } as const;
  return style;
}

/** A flat rectangle centred on a point in that space. */
export function plane(width: number, height: number, transform: string): ViewStyle {
  const style = {
    position: "absolute",
    left: -width / 2,
    top: -height / 2,
    width,
    height,
    transform,
    backfaceVisibility: "hidden",
  } as const;
  return style;
}

/** A sprite that always faces the eye: placed and turned every frame. */
export function sprite(width: number, height: number): ViewStyle {
  const style = {
    position: "absolute",
    left: -width / 2,
    top: -height / 2,
    width,
    height,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  return style;
}
