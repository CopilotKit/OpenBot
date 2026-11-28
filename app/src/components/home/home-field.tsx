import { useReducedMotion } from "motion/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type createHomeIntro,
  fieldEnergy,
  HOME_FIELD_COLORS,
  HOME_FIELD_FRAGMENT,
  HOME_FIELD_VERTEX,
  homeIntro,
} from "@/lib/home-field";
import { DEFAULT_SKIN, useSkinId } from "@/skins/store";

/** How long the first-view intro takes, in seconds: the orb in, then each ring drawn. */
const INTRO_SECONDS = 1.3;

/**
 * Whether Home plays its intro: on the first Home of a visit only (`homeIntro`), and never when
 * the person has asked for less motion. Read once per mount, so a re-render keeps the answer.
 */
export function useHomeIntro(
  record: ReturnType<typeof createHomeIntro> = homeIntro,
): boolean {
  const reduce = useReducedMotion() ?? false;
  const [plays] = useState(() => record.plays());
  useEffect(() => {
    if (plays) record.played();
  }, [plays, record]);
  return plays && !reduce;
}

type Program = {
  gl: WebGLRenderingContext;
  uniform: (name: string) => WebGLUniformLocation | null;
};

/** The field's program, or null where WebGL is missing or refuses it. */
function compile(canvas: HTMLCanvasElement): Program | null {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    premultipliedAlpha: true,
  });
  if (!gl) return null;
  const shader = (type: number, source: string) => {
    const made = gl.createShader(type);
    if (!made) return null;
    gl.shaderSource(made, source);
    gl.compileShader(made);
    return gl.getShaderParameter(made, gl.COMPILE_STATUS) ? made : null;
  };
  const vertex = shader(gl.VERTEX_SHADER, HOME_FIELD_VERTEX);
  const fragment = shader(gl.FRAGMENT_SHADER, HOME_FIELD_FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  HOME_FIELD_COLORS.forEach((color, i) => {
    gl.uniform3fv(gl.getUniformLocation(program, `uC${i}`), color);
  });
  return { gl, uniform: (name) => gl.getUniformLocation(program, name) };
}

/**
 * The orb's field behind Home's message box (`lib/home-field.ts`): a pale gradient in the orb's
 * colours, centred on the box, with three rings of soft dots round its rim. It drifts slowly, and
 * typing lights it. On the first view (`intro`) the orb fades in and the rings draw themselves.
 *
 * It sits behind the page in the nearest `isolate` box, covering it, and follows the message box
 * inside `area` wherever the layout puts it. Only on OpenBot's own look: a skin draws its own
 * palette. With less motion asked for, it is drawn still. With no WebGL, nothing is drawn. It
 * reads light or dark off the page itself (`.dark` on `<html>`), so it needs nothing round it and
 * can never break the page it decorates.
 */
export function HomeField({
  area,
  intro,
}: {
  area: RefObject<HTMLElement | null>;
  intro: boolean;
}) {
  const skin = useSkinId();
  const still = useReducedMotion() ?? false;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(true);
  /* Read by the running loop, so a motion change redraws without starting over. */
  const now = useRef({ still });
  const redraw = useRef<() => void>(() => {});
  /* The intro runs once per mount: a later redraw of the same Home never replays it. */
  const introLeft = useRef(intro ? 0 : 1);

  useEffect(() => {
    if (skin !== DEFAULT_SKIN) return;
    const canvas = canvasRef.current;
    const holder = area.current;
    if (!canvas || !holder) return;
    const program = compile(canvas);
    if (!program) {
      setDrawn(false);
      return;
    }
    const { gl, uniform } = program;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    let energy = 0;
    let wanted = 0;
    let clock = 7;
    let last = 0;
    let frame = 0;

    const box = () =>
      holder.querySelector<HTMLElement>('[data-slot="composer"]') ?? holder;
    const readTyping = () => {
      const frameEl = box();
      wanted = fieldEnergy({
        focused: frameEl.contains(document.activeElement),
        hasText: frameEl.hasAttribute("data-typing"),
      });
      request();
    };

    const draw = (time: number) => {
      frame = 0;
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 0;
      last = time;
      const isStill = now.current.still;
      const isDark = document.documentElement.classList.contains("dark");
      if (!isStill) clock += dt;
      energy = isStill
        ? wanted
        : energy + (wanted - energy) * (1 - Math.exp(-dt * 5));
      introLeft.current = isStill
        ? 1
        : Math.min(1, introLeft.current + dt / INTRO_SECONDS);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const c = canvas.getBoundingClientRect();
      const b = box().getBoundingClientRect();
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform4f(
        uniform("uBox"),
        (b.left - c.left) * dpr,
        (c.bottom - b.bottom) * dpr,
        b.width * dpr,
        b.height * dpr,
      );
      gl.uniform1f(uniform("uTime"), clock);
      gl.uniform1f(uniform("uEnergy"), energy);
      gl.uniform1f(uniform("uDark"), isDark ? 1 : 0);
      gl.uniform1f(uniform("uDpr"), dpr);
      gl.uniform1f(uniform("uIntro"), introLeft.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Still, once settled, it waits for the next change instead of drawing every frame.
      const settled =
        isStill ||
        (Math.abs(wanted - energy) < 0.001 && introLeft.current >= 1);
      if (!isStill || !settled) request();
    };
    function request() {
      if (!frame) frame = requestAnimationFrame(draw);
    }
    redraw.current = request;

    const typing = new MutationObserver(readTyping);
    typing.observe(holder, {
      attributeFilter: ["data-typing"],
      attributes: true,
      subtree: true,
    });
    holder.addEventListener("focusin", readTyping);
    holder.addEventListener("focusout", readTyping);
    const theme = new MutationObserver(request);
    theme.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    const sizes = new ResizeObserver(request);
    sizes.observe(canvas);
    sizes.observe(holder);
    readTyping();

    return () => {
      cancelAnimationFrame(frame);
      typing.disconnect();
      theme.disconnect();
      sizes.disconnect();
      holder.removeEventListener("focusin", readTyping);
      holder.removeEventListener("focusout", readTyping);
      redraw.current = () => {};
      // The context is not lost here: a canvas hands back the same one when the effect runs
      // again (React runs it twice in development), and a lost one draws nothing. The browser
      // frees it with the canvas.
    };
  }, [area, skin]);

  // A motion change: the running loop reads it, and draws again with it.
  useEffect(() => {
    now.current = { still };
    redraw.current();
  }, [still]);

  if (skin !== DEFAULT_SKIN) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
      data-slot="home-field"
    >
      <canvas className="size-full" hidden={!drawn} ref={canvasRef} />
    </div>
  );
}
