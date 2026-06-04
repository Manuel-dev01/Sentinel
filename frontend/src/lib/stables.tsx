"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { STABLES, type Stable } from "./contracts";

/**
 * Selected-stable context. The protocol insures multiple stablecoins (registered at deploy and
 * synced into `STABLES`); the dashboard + coverage screens operate on one at a time. The pool and
 * LP screen are shared capital, so they stay global. Selection persists to localStorage so it
 * survives navigation between routes.
 */
type StableCtxValue = {
  stables: readonly Stable[];
  selected: Stable;
  setSelected: (address: string) => void;
};

const StableCtx = createContext<StableCtxValue | null>(null);
const STORAGE_KEY = "sentinel.selectedStable";

export function StableProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string>(STABLES[0].address);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved && STABLES.some((s) => s.address.toLowerCase() === saved.toLowerCase())) {
      setAddress(saved);
    }
  }, []);

  const setSelected = (a: string) => {
    setAddress(a);
    try {
      window.localStorage.setItem(STORAGE_KEY, a);
    } catch {
      /* ignore quota / SSR */
    }
  };

  const selected = STABLES.find((s) => s.address.toLowerCase() === address.toLowerCase()) ?? STABLES[0];

  return <StableCtx.Provider value={{ stables: STABLES, selected, setSelected }}>{children}</StableCtx.Provider>;
}

export function useStable(): StableCtxValue {
  const ctx = useContext(StableCtx);
  if (!ctx) throw new Error("useStable must be used within <StableProvider>");
  return ctx;
}

/**
 * Stablecoin selector, grouped into DEMO (operator-simulated) and LIVE (autonomously monitored,
 * real coverage). Hidden when only one is registered.
 */
export function StableSelector() {
  const { stables, selected, setSelected } = useStable();
  if (stables.length <= 1) return null;
  const demo = stables.filter((s) => !s.monitored);
  const live = stables.filter((s) => s.monitored);

  const group = (label: string, list: Stable[], isLive: boolean) =>
    list.length === 0 ? null : (
      <div className="stable-group">
        <span className="stable-group-label">{label}</span>
        <div className="stable-tabs" role="tablist" aria-label={`${label} stablecoins`}>
          {list.map((s) => {
            const active = s.address.toLowerCase() === selected.address.toLowerCase();
            return (
              <button
                key={s.address}
                role="tab"
                aria-selected={active}
                className={`stable-tab${active ? " active" : ""}${isLive ? " live" : ""}`}
                onClick={() => setSelected(s.address)}
                title={isLive ? `${s.symbol} — autonomously monitored, real coverage` : s.symbol}
              >
                {isLive && <span className="stable-live-dot" />}
                {isLive ? s.symbol.replace("·live", "") : s.symbol}
              </button>
            );
          })}
        </div>
      </div>
    );

  return (
    <div className="stable-groups">
      {group("DEMO", demo, false)}
      {group("LIVE", live, true)}
    </div>
  );
}
