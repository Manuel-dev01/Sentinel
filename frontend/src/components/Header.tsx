"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBlockNumber } from "wagmi";
import { ConnectWallet } from "./ConnectWallet";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/policies", label: "Coverage" },
  { href: "/lp", label: "Liquidity" },
];

export function Header() {
  const pathname = usePathname();
  const { data: block } = useBlockNumber({ watch: true });

  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-strip">
        <div className="left">
          <span className="net">SOMNIA TESTNET</span>
          <span>CHAIN 50312</span>
        </div>
        <div className="center">
          BLOCK
          <span className="tick">{block ? `#${block.toLocaleString("en-US")}` : "—"}</span>
        </div>
        <div className="right">REACTIVITY · ARMED</div>
      </div>

      <div className="nav-inner">
        <Link className="brand" href="/" aria-label="Sentinel">
          <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect
              x="6"
              y="6"
              width="20"
              height="20"
              transform="rotate(45 16 16)"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="16" cy="16" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="16" cy="16" r="3.1" fill="#7000FF" />
          </svg>
          <span className="name">
            SENTI<b>NEL</b>
          </span>
        </Link>

        <div className="nav-links">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={active ? { color: "var(--violet)" } : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="nav-cta">
          <ConnectWallet />
        </div>
      </div>
    </nav>
  );
}
