import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/toast";
import type { NativeControl } from "../src/fakeNative/control";
import { PAGE_COMMANDS } from "../src/fakeNative/pageRegistry";
import { COMMANDS } from "../src/fakeNative/registry";
import { ApiAnswersPanel } from "./ApiAnswersPanel";
import { appFrameConfig } from "./appFrameConfig";
import { buildScreenPrompt } from "./askPrompt";
import { CallLog } from "./CallLog";
import { CommandsPanel } from "./CommandsPanel";
import { copyText } from "./clipboard";
import { CRITIQUE_COMMANDS, type CritiqueCommand } from "./critiquePrompt";
import { EventsPanel } from "./EventsPanel";
import { frameUrl, type FrameConfig } from "./frameConfig";
import { isTextField } from "./keyTargets";
import { describeElements } from "./layoutWatch";
import { pickArea } from "./pickElement";
import { RequestLog } from "./RequestLog";
import { SceneList } from "./SceneList";
import { Fold, NoticeList, tell } from "./Shell";
import { StreamPanel } from "./StreamPanel";
import { isApp, loadScenes, type SceneEntry } from "./sceneCatalog";
import { resolveTarget } from "./sourceLines";
import { windowButtonsBox } from "./titleBar";
import {
  DEFAULT_APP,
  decodeState,
  encodeState,
  type WorkbenchState,
} from "./urlState";
import { useLayoutWatch } from "./useLayoutWatch";
import {
  frameOrigin,
  WarningHighlight,
  type FrameOrigin,
} from "./WarningHighlight";
import { WarningsList, warningKey } from "./WarningsList";
import { WindowFrame } from "./WindowFrame";
import { type SelectMode, WindowSettingsPanel } from "./WindowSettingsPanel";
import { readPref, writePref } from "./viewerPrefs";
import type { Warning } from "./layoutWatch";

type FrameWindow = Window & typeof globalThis;
export type WorkbenchPage = {
  readonly ready: boolean;
  readonly scene: string;
  readonly kind: "desktop" | "app";
  route(): string;
  config(): WorkbenchState;
  calls(): ReturnType<NativeControl["calls"]>;
  warnings(): Warning[];
  elements(): ReturnType<typeof describeElements>;
  requests(): readonly import("./appContract").ApiRecord[];
  errors(): readonly string[];
};
declare global {
  interface Window {
    __workbenchPage?: WorkbenchPage;
  }
}

export function Workbench() {
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof loadScenes>
  > | null>(null);
  useEffect(() => {
    let active = true;
    void loadScenes().then((value) => {
      if (active) setCatalog(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Toaster>
      {catalog ? (
        <WorkbenchLoaded
          catalog={catalog.scenes}
          catalogNotices={catalog.notices}
        />
      ) : (
        <p role="status">Loading views…</p>
      )}
    </Toaster>
  );
}
export type WorkbenchLoadedProps = {
  catalog: readonly SceneEntry[];
  catalogNotices: readonly string[];
};
/** Select mode is this viewer's choice, kept in this browser only. */
const SELECT_MODE_PREF = "selectMode";

function isSelectMode(value: unknown): value is SelectMode {
  return value === "inspect" || value === "off";
}

export function WorkbenchLoaded({
  catalog,
  catalogNotices,
}: WorkbenchLoadedProps) {
  const [boot] = useState(() =>
    decodeState(window.location.search, catalog, [
      ...COMMANDS,
      ...PAGE_COMMANDS,
    ]),
  );
  const [state, setState] = useState(boot.state);
  const [notices, setNotices] = useState([...catalogNotices, ...boot.notices]);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [route, setRoute] = useState(state.route ?? "");
  const [address, setAddress] = useState(state.route ?? "");
  const [commenting, setCommenting] = useState(false);
  const [selectMode, setSelectMode] = useState<SelectMode>(
    () => readPref(SELECT_MODE_PREF, isSelectMode) ?? "inspect",
  );
  const [command, setCommand] = useState<CritiqueCommand>("critique");
  const [gridColor, setGridColor] = useState("#ff00ff");
  const [fit, setFit] = useState(
    !new URLSearchParams(window.location.search).has("zoom"),
  );
  const [fitZoom, setFitZoom] = useState(1);
  const [highlight, setHighlight] = useState<{
    warning: Warning;
    pinned: boolean;
    key: string;
  } | null>(null);
  const editingRoute = useRef(false);
  const [origin, setOrigin] = useState<FrameOrigin | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scene = catalog.find((one) => one.id === state.scene) ?? catalog[0];
  const appScene = scene && isApp(scene) ? scene : null;
  const appConfig = appScene ? appFrameConfig(state, appScene) : null;
  const setupConfig: FrameConfig | null =
    scene && !isApp(scene)
      ? {
          hash: scene.start.hash,
          search: scene.start.search,
          os: state.window.os,
          theme: state.window.theme,
          env: { ...scene.start.env, ...state.env },
          answers: { ...scene.start.answers, ...state.answers },
        }
      : null;
  // These boot values are read synchronously by each new frame, before its entry executes.
  window.__workbenchAppFrame = appConfig ?? undefined;
  window.__workbenchFrame = setupConfig ?? undefined;
  const host = appConfig?.host ?? "desktop";
  const kind = appScene ? "app" : "desktop";
  const zoom = fit ? fitZoom : state.window.zoom;
  const win = frame?.contentWindow as FrameWindow | null;
  const control = ready ? (win?.__workbench ?? null) : null;
  const api = ready ? (win?.__workbenchApi ?? null) : null;
  const { warnings } = useLayoutWatch(frame, {
    width: state.window.width,
    height: state.window.height,
    buttons: windowButtonsBox(state.window.os, host),
  });
  const latest = useRef({ state, route, warnings, ready });
  latest.current = { state, route, warnings, ready };
  const snapshotConfig = useCallback((): WorkbenchState => {
    const current = latest.current;
    return {
      ...current.state,
      route: kind === "app" ? current.route || undefined : undefined,
    };
  }, [kind]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these changes trigger a fresh snapshot of the refs.
  useEffect(() => {
    const query = encodeState(snapshotConfig());
    const params = new URLSearchParams(query);
    if (fit) params.delete("zoom");
    window.history.replaceState(null, "", `?${params}`);
  }, [state, route, fit, snapshotConfig]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () =>
      setFitZoom(
        Math.max(
          0.25,
          Math.min(
            1,
            (el.clientWidth - 32) / state.window.width,
            (el.clientHeight - 32) / state.window.height,
          ),
        ),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [state.window.width, state.window.height]);
  // Poll only the frame boundary and route. The app's timers, animation and router run normally.
  useEffect(() => {
    if (!frame) return;
    let stopKeys: (() => void) | undefined;
    let listening: Document | undefined;
    const update = () => {
      const current = frame.contentWindow as FrameWindow | null;
      const loaded = current?.__workbenchBooted === true;
      setReady(loaded);
      if (!loaded || !current) return;
      if (appScene) {
        const next = `${current.location.pathname}${current.location.search}${current.location.hash}`;
        setRoute(next);
        if (!editingRoute.current) setAddress(next);
      }
      if (listening !== current.document) {
        stopKeys?.();
        listening = current.document;
        const key = (event: KeyboardEvent) => {
          if (
            event.key.toLowerCase() === "c" &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !isTextField(event.target)
          ) {
            event.preventDefault();
            setCommenting((on) => !on);
          }
          if (event.key === "Escape") {
            setCommenting(false);
            setHighlight(null);
          }
        };
        current.document.addEventListener("keydown", key);
        stopKeys = () => current.document.removeEventListener("keydown", key);
      }
    };
    const timer = setInterval(update, 100);
    update();
    return () => {
      clearInterval(timer);
      stopKeys?.();
    };
  }, [frame, appScene]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        isTextField(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        setCommenting((on) => !on);
      }
      if (event.key === "Escape") {
        setCommenting(false);
        setHighlight(null);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    window.__workbenchPage = {
      get ready() {
        return latest.current.ready;
      },
      scene: state.scene,
      kind,
      route: () => latest.current.route,
      config: snapshotConfig,
      calls: () => win?.__workbench?.calls() ?? [],
      warnings: () => latest.current.warnings,
      elements: () => (win ? describeElements(win.document) : []),
      requests: () => win?.__workbenchApi?.requests() ?? [],
      errors: () => win?.__workbenchErrors ?? [],
    };
    return () => {
      delete window.__workbenchPage;
    };
  }, [state.scene, kind, win, snapshotConfig]);
  // View and host/session changes restart the boundary; sizing, zoom, theme and inspection stay live.
  const frameKey = JSON.stringify([
    state.scene,
    state.window.os,
    state.app,
    state.env,
    reload,
  ]);
  const onFrame = useCallback((next: HTMLIFrameElement | null) => {
    setFrame(next);
    setReady(false);
    setHighlight(null);
  }, []);
  useEffect(() => {
    if (ready) win?.__workbenchSetTheme?.(state.window.theme);
  }, [win, state.window.theme, ready]);
  useEffect(() => {
    setHighlight((old) => {
      if (!old) return null;
      const warning = warnings.find((one) => warningKey(one) === old.key);
      return warning ? { ...old, warning } : null;
    });
  }, [warnings]);
  const pickView = (id: string) => {
    setState((old) => ({
      ...old,
      scene: id,
      route: undefined,
      answers: {},
      api: {},
      env: {},
    }));
    setRoute("");
    setAddress("");
    setReady(false);
    setReload((n) => n + 1);
  };
  const navigate = () => {
    if (!win || !address.startsWith("/") || address.startsWith("//")) return;
    const router = (
      win as FrameWindow & {
        __TSR_ROUTER__?: {
          navigate(options: { to: string }): Promise<unknown>;
        };
      }
    ).__TSR_ROUTER__;
    if (router) void router.navigate({ to: address });
    else {
      win.history.pushState(null, "", address);
      win.dispatchEvent(new win.PopStateEvent("popstate"));
    }
  };
  const copyLink = async () => {
    const params = encodeState(snapshotConfig());
    await copyText(
      `${window.location.origin}${window.location.pathname}?${params}`,
    );
    tell("Copied.");
  };
  const copyScreen = async () => {
    if (!win || !scene) return;
    const area = {
      x: 0,
      y: 0,
      width: state.window.width,
      height: state.window.height,
    };
    const picked = {
      kind: "area" as const,
      area,
      elements: pickArea(area, win.document),
    };
    const resolved = await resolveTarget(picked).catch(() => picked);
    await copyText(
      buildScreenPrompt(
        command,
        resolved.kind === "area" ? resolved.elements : [],
        {
          scene,
          window: state.window,
          link: `${location.origin}${location.pathname}?${encodeState(snapshotConfig())}`,
          app: appScene ? { route, host } : undefined,
        },
        { kind, warnings },
      ),
    );
    tell("Copied.");
  };
  useEffect(() => {
    const wrapper = wrap.current;
    const canvas = stage.current;
    if (!wrapper || !frame || !canvas) return;
    const measure = () => {
      const next = frameOrigin(wrapper, frame, state.window.width);
      setOrigin((old) =>
        old?.x === next.x && old.y === next.y && old.scale === next.scale
          ? old
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    observer.observe(canvas);
    canvas.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      canvas.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [frame, state.window.width]);
  if (!scene) return <p>No views are available.</p>;
  return (
    <div className="grid h-dvh grid-cols-[14rem_minmax(0,1fr)_19rem] bg-background text-foreground">
      <aside className="flex min-w-0 flex-col gap-3 overflow-y-auto bg-sidebar px-3 py-4 text-sidebar-foreground">
        <h1 className="text-sm font-medium">Workbench</h1>
        <p className="text-xs text-muted-foreground">
          Open a view, then use the real app.
        </p>
        <SceneList scenes={catalog} current={state.scene} onPick={pickView} />
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-col bg-background">
        <NoticeList
          notices={notices}
          onClose={(index) =>
            setNotices((all) => all.filter((_, i) => i !== index))
          }
        />
        <form
          className="flex items-center gap-2 border-b border-border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            navigate();
          }}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!ready || !appScene}
            onClick={() => win?.history.back()}
          >
            Back
          </Button>
          <Input
            aria-label="App route"
            disabled={!appScene}
            value={address}
            placeholder={route || appScene?.start.route || "Setup window"}
            onFocus={() => {
              editingRoute.current = true;
            }}
            onBlur={() => {
              editingRoute.current = false;
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!ready || !appScene}
          >
            Go
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!ready}
            onClick={() => {
              setState((old) => ({ ...old, route: route || undefined }));
              setReady(false);
              setReload((n) => n + 1);
            }}
          >
            Reload
          </Button>
        </form>
        {appScene && (
          <p
            className="px-3 py-1 text-xs text-muted-foreground"
            role="status"
            aria-label="Current route"
          >
            {route || appScene.start.route}
          </p>
        )}
        <div className="relative min-h-0 flex-1 overflow-auto p-4" ref={stage}>
          <div className="relative inline-block align-top" ref={wrap}>
            <WindowFrame
              src={
                setupConfig
                  ? frameUrl(setupConfig)
                  : state.route || appScene?.start.route || "/"
              }
              frameKey={frameKey}
              host={host}
              address={route || appScene?.start.route}
              titled={!!appScene}
              {...state.window}
              zoom={zoom}
              gridColor={gridColor}
              inspect={selectMode === "inspect"}
              onFrame={onFrame}
              comment={
                commenting
                  ? {
                      scene,
                      window: state.window,
                      frameInfo: { kind, warnings },
                      app: appScene ? { route, host } : undefined,
                    }
                  : null
              }
            />
            {highlight && origin && (
              <WarningHighlight
                warning={highlight.warning}
                origin={origin}
                viewport={state.window}
              />
            )}
          </div>
        </div>
        <div className="h-[25vh] flex-none overflow-y-auto border-t border-border px-3 pb-3">
          <WarningsList
            warnings={warnings}
            onHover={(warning) =>
              setHighlight((old) =>
                old?.pinned
                  ? old
                  : { warning, key: warningKey(warning), pinned: false },
              )
            }
            onPin={(warning) =>
              setHighlight((old) =>
                old?.key === warningKey(warning) && old.pinned
                  ? null
                  : { warning, key: warningKey(warning), pinned: true },
              )
            }
            onLeave={() => setHighlight((old) => (old?.pinned ? old : null))}
            highlight={highlight}
          />
        </div>
      </main>
      <aside className="flex min-w-0 flex-col gap-6 overflow-y-auto bg-sidebar px-3 py-4 text-sidebar-foreground">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Request changes</h2>
          <Button
            size="sm"
            variant={commenting ? "default" : "outline"}
            aria-pressed={commenting}
            aria-keyshortcuts="C"
            onClick={() => setCommenting((on) => !on)}
          >
            Comment
          </Button>
          <p className="text-xs text-muted-foreground">
            Click an element or drag over an area. Copy the request with its
            source and view settings. C toggles comments.
          </p>
          <Select
            value={command}
            onValueChange={(value) => setCommand(value as CritiqueCommand)}
          >
            <SelectTrigger size="sm" aria-label="Impeccable command">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CRITIQUE_COMMANDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready}
            onClick={() =>
              void copyScreen().catch(() =>
                tell("The browser could not copy the prompt.", "error"),
              )
            }
          >
            Critique this screen
          </Button>
        </section>
        <WindowSettingsPanel
          value={state.window}
          gridColor={gridColor}
          onGridColor={setGridColor}
          selectMode={selectMode}
          onSelectMode={(mode) => {
            setSelectMode(mode);
            writePref(SELECT_MODE_PREF, mode);
          }}
          fit={{ on: fit, zoom: fitZoom }}
          onFit={setFit}
          onCopyLink={() =>
            void copyLink().catch(() =>
              tell("The browser could not copy the link.", "error"),
            )
          }
          onChange={(patch) => {
            if (patch.zoom !== undefined) setFit(false);
            setState((old) => ({
              ...old,
              window: { ...old.window, ...patch },
            }));
          }}
          app={
            appConfig
              ? {
                  host: appConfig.host,
                  role: appConfig.role,
                  skin: state.app?.skin ?? null,
                  sidebar: state.app?.sidebar ?? null,
                }
              : undefined
          }
          onAppChange={(patch) => {
            setState((old) => ({
              ...old,
              route: route || undefined,
              app: { ...DEFAULT_APP, ...old.app, ...patch },
            }));
            setReady(false);
          }}
        />
        <Fold title="Advanced">
          <Fold title="Native commands">
            <CommandsPanel
              control={control}
              commands={appScene ? PAGE_COMMANDS : undefined}
              onAnswer={(name, answer) =>
                setState((old) => ({
                  ...old,
                  answers: { ...old.answers, [name]: answer },
                }))
              }
            />
          </Fold>
          <Fold title="Calls">
            <CallLog control={control} />
          </Fold>
          {appScene ? (
            <>
              <Fold title="Requests">
                <RequestLog api={api} />
              </Fold>
              <Fold title="API answers">
                <ApiAnswersPanel
                  api={api}
                  picked={null}
                  onAnswer={(name, answer) =>
                    setState((old) => {
                      const api = { ...old.api };
                      if (answer === null) delete api[name];
                      else api[name] = answer;
                      return { ...old, api };
                    })
                  }
                />
              </Fold>
              <Fold title="Streams and sockets">
                <StreamPanel
                  streams={ready ? (win?.__workbenchStreams ?? null) : null}
                  sockets={ready ? (win?.__workbenchSockets ?? null) : null}
                />
              </Fold>
            </>
          ) : (
            <Fold title="Events">
              <EventsPanel control={control} />
            </Fold>
          )}
        </Fold>
      </aside>
    </div>
  );
}
