"use client";

import dynamic from "next/dynamic";

const WalletPanel = dynamic(() => import("./components/WalletPanel"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[320px] w-full max-w-lg items-center justify-center rounded-2xl border border-zinc-200 bg-white text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
      Loading wallet…
    </div>
  ),
});

export default function WalletRoot() {
  return <WalletPanel />;
}
