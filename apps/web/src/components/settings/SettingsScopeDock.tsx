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
import { useLocation } from "@tanstack/react-router";

import { SETTINGS_DEVICE_ONLY_PATHS, SettingsScopeSentence } from "./SettingsScopeSentence";

interface SettingsScopeDockValue {
  readonly docked: boolean;
  readonly setSource: (element: HTMLDivElement | null) => void;
  readonly setToolbar: (element: HTMLDivElement | null) => void;
}

const SettingsScopeDockContext = createContext<SettingsScopeDockValue | null>(null);

/** Move one mounted set of menus, retaining their open state and keyboard focus. */
export function SettingsScopeDockProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);
  const dockedRef = useRef(false);
  // The docked state a scroll crossing is moving to; any other move stays still.
  const animateNextMove = useRef<boolean | null>(null);
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );

  useLayoutEffect(() => {
    const target = docked ? toolbar : source;
    if (!host || !target) return;
    const previous = host.parentElement;
    // Replacing page content also reparents the host; only a scroll crossing animates.
    const animate = animateNextMove.current === docked && previous === (docked ? source : toolbar);
    animateNextMove.current = null;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    target.append(host);
    if (!docked && source) releaseSourceHeight(source);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });

    // Panel animations default to off, so only the OS preference disables this short cue.
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
      animateNextMove.current = animate ? next : null;
      // Retain the sentence's space so docking cannot change the scroll position.
      if (next && !source.style.height) {
        source.style.setProperty("height", `${source.getBoundingClientRect().height}px`);
      }
      // Crossing back within one frame never moved the controls out.
      if (!next && source.contains(host)) source.style.removeProperty("height");
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
    const observer = new ResizeObserver(measure);
    observer.observe(source);
    observer.observe(scroll);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", onScroll);
      // Each page starts with its sentence in place; device-only pages have none.
      dockedRef.current = false;
      animateNextMove.current = null;
      setDocked(false);
    };
  }, [host, source]);

  const value = useMemo(() => ({ docked, setSource, setToolbar }), [docked]);

  return (
    <SettingsScopeDockContext value={value}>
      {children}
      {host && source ? createPortal(<SettingsScopeSentence compact={docked} />, host) : null}
    </SettingsScopeDockContext>
  );
}

/**
 * Unpins the sentence's space after the controls return. A resize while docked
 * can leave the pin taller or shorter than the sentence, so the scroll position
 * absorbs the difference instead of the content jumping.
 */
function releaseSourceHeight(source: HTMLElement) {
  if (!source.style.height) return;
  const scroll = source.closest<HTMLElement>("[data-settings-page-scroll]");
  const pinned = source.getBoundingClientRect().height;
  const scrollTop = scroll?.scrollTop ?? 0;
  source.style.removeProperty("height");
  const shift = pinned - source.getBoundingClientRect().height;
  // Browsers with scroll anchoring may already have compensated.
  if (scroll && shift !== 0 && scroll.scrollTop === scrollTop) scroll.scrollTop = scrollTop - shift;
}

export function useSettingsScopeDocked() {
  return useContext(SettingsScopeDockContext)?.docked ?? false;
}

/** The original sentence position also marks when its menus should enter the toolbar. */
export function SettingsScopeInline() {
  const dock = useContext(SettingsScopeDockContext);
  const pathname = useLocation({ select: (location) => location.pathname });
  if (!dock || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const { setSource } = dock;
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
