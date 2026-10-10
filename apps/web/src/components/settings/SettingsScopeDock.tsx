import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { SettingsScopeSentence } from "./SettingsScopeSentence";
import { observeResize } from "~/lib/observeResize";

interface SettingsScopeDockValue {
  readonly enabled: boolean;
  readonly docked: boolean;
  readonly setSource: (element: HTMLDivElement | null) => void;
  readonly setToolbar: (element: HTMLDivElement | null) => void;
}

const SettingsScopeDockContext = createContext<SettingsScopeDockValue | null>(null);

/** Move one mounted set of menus, retaining their open state and keyboard focus. */
export function SettingsScopeDockProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);
  const dockedRef = useRef(false);
  const animateNextMove = useRef(false);
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );

  useLayoutEffect(() => {
    const target = docked ? toolbar : source;
    if (!host || !target) return;
    const previous = host.parentElement;
    // Replacing page content also reparents the host; only a scroll crossing animates.
    const animate = animateNextMove.current && previous === (docked ? source : toolbar);
    animateNextMove.current = false;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    target.append(host);
    if (!docked && source) source.style.removeProperty("height");
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });

    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Move both pickers together so wrapped labels cannot cross during docking.
    const animation = host.animate(
      [
        { transform: `translateY(${docked ? 8 : -8}px)`, opacity: 0 },
        { transform: "translateY(0px)", opacity: 1 },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    return () => animation.cancel();
  }, [docked, host, source, toolbar]);

  useLayoutEffect(() => {
    const scroll = source?.closest<HTMLElement>("[data-settings-page-scroll]");
    if (!source || !scroll) return;
    let threshold = Infinity;
    const updateDocked = (animate: boolean) => {
      const next = scroll.scrollTop >= threshold;
      if (next === dockedRef.current) return;
      dockedRef.current = next;
      animateNextMove.current = animate;
      // Retain the sentence's space so docking cannot change the scroll position.
      if (next && !source.style.height) {
        source.style.setProperty("height", `${source.getBoundingClientRect().height}px`);
      }
      setDocked(next);
    };
    const onScroll = () => updateDocked(true);
    const measure = () => {
      threshold =
        scroll.scrollTop +
        source.getBoundingClientRect().bottom -
        scroll.getBoundingClientRect().top;
      // Initial layout and page replacements establish placement without entrance motion.
      updateDocked(false);
    };
    // Geometry is measured on layout changes; scrolling only compares two numbers.
    const stopObserving = observeResize([source, scroll], measure);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      stopObserving();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [source]);

  const value = useMemo(() => ({ enabled, docked, setSource, setToolbar }), [enabled, docked]);

  return (
    <SettingsScopeDockContext value={value}>
      {children}
      {host && source ? createPortal(<SettingsScopeSentence compact={docked} />, host) : null}
    </SettingsScopeDockContext>
  );
}

export function useSettingsScopeDocked() {
  return useContext(SettingsScopeDockContext)?.docked ?? false;
}

/** The original sentence position also marks when its menus should enter the toolbar. */
export function SettingsScopeInline() {
  const dock = useContext(SettingsScopeDockContext);
  if (!dock) return <SettingsScopeSentence />;
  const { enabled, setSource } = dock;
  if (!enabled) return null;
  return <div ref={setSource} data-settings-scope-source />;
}

export function SettingsScopeToolbar() {
  const dock = useContext(SettingsScopeDockContext);
  return (
    <div
      ref={dock?.setToolbar}
      data-settings-scope-toolbar
      className={dock?.docked ? "min-w-0 flex-1" : "hidden"}
    />
  );
}
