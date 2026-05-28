import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { somniaTestnet } from "./chains";

// WalletConnect projectId: a real id is required for WalletConnect-based wallets to work.
// Placeholder during scaffold — replace with a real id from cloud.walletconnect.com before demo.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "sentinel-placeholder";

export const wagmiConfig = getDefaultConfig({
  appName: "Sentinel",
  projectId,
  chains: [somniaTestnet],
  ssr: true,
});
