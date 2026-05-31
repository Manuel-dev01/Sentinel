"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

/**
 * Brand-matched wallet button. Wraps RainbowKit's headless ConnectButton.Custom so the trigger
 * uses our `.pill` system (mono, ink/violet) instead of RainbowKit's rounded default — which
 * clashed with the Editorial Technical nav. The modal itself is themed in providers.tsx.
 */
export function ConnectWallet() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected =
          ready && account && chain && (!authenticationStatus || authenticationStatus === "authenticated");

        return (
          <div
            aria-hidden={!ready}
            style={!ready ? { opacity: 0, pointerEvents: "none", userSelect: "none" } : undefined}
          >
            {!connected ? (
              <button className="pill solid" onClick={openConnectModal} type="button">
                <span>Connect wallet</span>
                <span className="arr" aria-hidden="true">
                  ↗
                </span>
              </button>
            ) : chain.unsupported ? (
              <button
                className="pill"
                onClick={openChainModal}
                type="button"
                style={{ borderColor: "var(--red)", color: "var(--red)" }}
              >
                Wrong network
              </button>
            ) : (
              <button className="pill solid" onClick={openAccountModal} type="button">
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />
                <span>{account.displayName}</span>
              </button>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
