"use client";

import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { AccountRequiresMemoError, Networks } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useState } from "react";
import {
  buildPaymentXdr,
  fetchNativeXlmBalance,
  formatHorizonError,
  getHorizonServer,
  isValidPublicKey,
  parseSignedTransaction,
  testnetTxExplorerUrl,
  TESTNET_PASSPHRASE,
} from "@/lib/stellar";

type TxFeedback =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string };

function freighterErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: string }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error.";
}

export default function WalletPanel() {
  const [extensionAvailable, setExtensionAvailable] = useState<boolean | null>(
    null,
  );
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [networkOk, setNetworkOk] = useState(true);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [txFeedback, setTxFeedback] = useState<TxFeedback>({ kind: "idle" });

  const refreshBalance = useCallback(async (key: string) => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const b = await fetchNativeXlmBalance(key);
      setBalance(b);
    } catch (e) {
      setBalance(null);
      setBalanceError(freighterErrorMessage(e));
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  const verifyTestnet = useCallback(async () => {
    const details = await getNetworkDetails();
    if (details.error) {
      setNetworkOk(false);
      return;
    }
    const ok = details.networkPassphrase === Networks.TESTNET;
    setNetworkOk(ok);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const connected = await isConnected();
      if (cancelled) return;
      if (connected.error || !connected.isConnected) {
        setExtensionAvailable(false);
        return;
      }
      setExtensionAvailable(true);
      const addr = await getAddress();
      if (cancelled) return;
      if (!addr.error && addr.address) {
        setPublicKey(addr.address);
        await verifyTestnet();
        void refreshBalance(addr.address);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshBalance, verifyTestnet]);

  const handleConnect = async () => {
    setBalanceError(null);
    const connected = await isConnected();
    if (connected.error || !connected.isConnected) {
      setExtensionAvailable(false);
      return;
    }
    setExtensionAvailable(true);
    const res = await requestAccess();
    if (res.error) {
      setBalanceError(res.error.message ?? "Could not connect.");
      return;
    }
    setPublicKey(res.address);
    await verifyTestnet();
    await refreshBalance(res.address);
  };

  const handleDisconnect = () => {
    setPublicKey(null);
    setBalance(null);
    setBalanceError(null);
    setNetworkOk(true);
    setTxFeedback({ kind: "idle" });
    setDestination("");
    setAmount("");
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;

    const dest = destination.trim();
    if (!isValidPublicKey(dest)) {
      setTxFeedback({ kind: "error", message: "Invalid destination." });
      return;
    }
    const amt = amount.trim();
    if (!amt || Number(amt) <= 0) {
      setTxFeedback({
        kind: "error",
        message: "Enter a valid XLM amount.",
      });
      return;
    }

    setTxFeedback({ kind: "pending" });
    try {
      const unsignedXdr = await buildPaymentXdr({
        sourcePublicKey: publicKey,
        destination: dest,
        amount: amt,
      });
      const signed = await signTransaction(unsignedXdr, {
        networkPassphrase: TESTNET_PASSPHRASE,
        address: publicKey,
      });
      if (signed.error) {
        setTxFeedback({
          kind: "error",
          message: signed.error.message ?? "Signing was declined or failed.",
        });
        return;
      }
      const server = getHorizonServer();
      const tx = parseSignedTransaction(signed.signedTxXdr);
      const result = await server.submitTransaction(tx);
      const hash = result.hash;
      setTxFeedback({ kind: "success", hash });
      await refreshBalance(publicKey);
    } catch (err) {
      if (err instanceof AccountRequiresMemoError) {
        setTxFeedback({
          kind: "error",
          message:
            "This destination requires a memo (SEP-29). Use another testnet account or include the memo the recipient expects.",
        });
        return;
      }
      const horizonMessage = formatHorizonError(err);
      const message = horizonMessage ?? freighterErrorMessage(err);
      setTxFeedback({ kind: "error", message });
    }
  };

  return (
    <div className="w-full max-w-lg space-y-8 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Stellar Testnet · Freighter
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Wallet & XLM
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Connect Freighter on the test network, view your balance, and send
          XLM. Install the extension and select Testnet in Freighter settings.
        </p>
      </header>

      {extensionAvailable === false && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        >
          Freighter not detected.{" "}
          <a
            href="https://www.freighter.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            Install Freighter
          </a>
        </div>
      )}

      <section className="space-y-4" aria-label="Wallet connection">
        {!publicKey ? (
          <button
            type="button"
            onClick={handleConnect}
            disabled={extensionAvailable === false}
            className="w-full rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Connect wallet
          </button>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-zinc-500">Account</p>
              <p className="truncate font-mono text-sm text-zinc-900 dark:text-zinc-100">
                {publicKey}
              </p>
            </div>
            <button
              type="button"
              onClick={handleDisconnect}
              className="shrink-0 rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-900"
            >
              Disconnect
            </button>
          </div>
        )}

        {publicKey && !networkOk && (
          <p
            role="alert"
            className="text-sm font-medium text-amber-700 dark:text-amber-300"
          >
            Freighter must be on the Testnet network for this app. Change it in
            the extension settings.
          </p>
        )}
      </section>

      {publicKey && (
        <section
          className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/80 p-5 dark:border-zinc-800 dark:bg-zinc-900/40"
          aria-label="XLM balance"
        >
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Balance (native)
          </h2>
          {balanceLoading ? (
            <p className="text-sm text-zinc-500">Loading balance…</p>
          ) : balanceError ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {balanceError}
            </p>
          ) : (
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {balance !== null ? `${balance} XLM` : "—"}
            </p>
          )}
          <button
            type="button"
            onClick={() => void refreshBalance(publicKey)}
            disabled={balanceLoading}
            className="text-sm font-medium text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-zinc-400"
          >
            Refresh balance
          </button>
        </section>
      )}

      {publicKey && networkOk && (
        <section aria-label="Send XLM">
          <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Send XLM (testnet)
          </h2>
          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <label
                htmlFor="destination"
                className="mb-1 block text-xs font-medium text-zinc-500"
              >
                Destination account
              </label>
              <input
                id="destination"
                value={destination}
                onChange={(ev) => setDestination(ev.target.value)}
                placeholder="G…"
                autoComplete="off"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <p className="mt-1 text-xs text-zinc-500">
                If the account does not exist on testnet yet, we create it and
                fund it with this amount (must be at least the network minimum,
                usually 1 XLM).
              </p>
            </div>
            <div>
              <label
                htmlFor="amount"
                className="mb-1 block text-xs font-medium text-zinc-500"
              >
                Amount (XLM)
              </label>
              <input
                id="amount"
                value={amount}
                onChange={(ev) => setAmount(ev.target.value)}
                placeholder="1.0"
                inputMode="decimal"
                autoComplete="off"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Up to 7 decimal places. Leave enough XLM for fees and the account
                minimum reserve (~1 XLM on unused accounts).
              </p>
            </div>
            <button
              type="submit"
              disabled={txFeedback.kind === "pending"}
              className="w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              {txFeedback.kind === "pending"
                ? "Sending…"
                : "Send transaction"}
            </button>
          </form>

          {txFeedback.kind === "success" && (
            <div
              className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
              role="status"
            >
              <p className="font-medium">Transaction submitted successfully</p>
              <p className="mt-1 break-all font-mono text-xs opacity-90">
                Hash: {txFeedback.hash}
              </p>
              <a
                href={testnetTxExplorerUrl(txFeedback.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block font-medium underline underline-offset-2"
              >
                View in explorer
              </a>
            </div>
          )}

          {txFeedback.kind === "error" && (
            <div
              className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
              role="alert"
            >
              <p className="font-medium">Transaction failed</p>
              <p className="mt-1">{txFeedback.message}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
