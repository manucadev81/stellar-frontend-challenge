import {
  Asset,
  Horizon,
  NetworkError,
  Networks,
  NotFoundError,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

export const TESTNET_PASSPHRASE = Networks.TESTNET;

const STROOPS_PER_LUMEN = BigInt(10_000_000);

let horizonServer: Horizon.Server | null = null;

export function getHorizonServer(): Horizon.Server {
  if (!horizonServer) {
    horizonServer = new Horizon.Server(HORIZON_TESTNET_URL);
  }
  return horizonServer;
}

export async function fetchNativeXlmBalance(publicKey: string): Promise<string> {
  const server = getHorizonServer();
  const account = await server.loadAccount(publicKey);
  const native = account.balances.find((b) => b.asset_type === "native");
  if (!native || native.asset_type !== "native") {
    return "0";
  }
  return native.balance;
}

export function isValidPublicKey(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/** Stellar amounts allow at most 7 fractional digits. */
export function normalizeXlmAmount(raw: string): string {
  const s = raw.trim();
  if (!/^\d+(\.\d*)?$/.test(s)) {
    throw new Error(
      "Amount must be a positive number with at most 7 decimal places.",
    );
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 7) {
    throw new Error("XLM supports at most 7 digits after the decimal.");
  }
  const trimmedFrac = frac.replace(/0+$/, "");
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
}

function lumensStringToStroops(lumens: string): bigint {
  const [w, f = ""] = lumens.split(".");
  const frac = (f + "0000000").slice(0, 7).padEnd(7, "0");
  return BigInt(w) * STROOPS_PER_LUMEN + BigInt(frac);
}

function stroopsToLumensDisplay(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_LUMEN;
  const frac = stroops % STROOPS_PER_LUMEN;
  if (frac === BigInt(0)) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

async function fetchBaseReserveStroops(server: Horizon.Server): Promise<number> {
  try {
    const page = await server.ledgers().order("desc").limit(1).call();
    return page.records[0].base_reserve_in_stroops;
  } catch {
    return 5_000_000;
  }
}

/** Minimum native balance the account must hold (ledger: (2 + subentries) × base reserve). */
function accountMinBalanceStroops(
  subentryCount: number,
  baseReserveStroops: number,
): bigint {
  return BigInt(2 + subentryCount) * BigInt(baseReserveStroops);
}

function getHorizonErrorPayload(
  err: NetworkError,
): Record<string, unknown> | undefined {
  const raw = err.response as unknown;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (
    o.data &&
    typeof o.data === "object" &&
    o.data !== null &&
    "title" in (o.data as object)
  ) {
    return o.data as Record<string, unknown>;
  }
  return o;
}

/**
 * Horizon returns 400 transaction failures as BadResponseError; the JSON body
 * is stored on NetworkError.response (sometimes nested as .data).
 */
export function formatHorizonError(err: unknown): string | null {
  if (!(err instanceof NetworkError)) {
    return null;
  }
  const body = getHorizonErrorPayload(err);
  if (!body) {
    return err.message;
  }
  const lines: string[] = [];
  if (typeof body.title === "string") {
    lines.push(body.title);
  }
  const detailText = body.details ?? body.detail;
  if (typeof detailText === "string" && detailText.trim()) {
    lines.push(detailText.trim());
  }
  const extras = body.extras as
    | {
        result_codes?: { transaction?: string; operations?: string[] };
        reason?: string;
      }
    | undefined;
  if (extras?.result_codes) {
    const { transaction: txCode, operations } = extras.result_codes;
    if (txCode) {
      lines.push(`Transaction: ${txCode}`);
    }
    if (operations?.length) {
      lines.push(`Operations: ${operations.join(", ")}`);
      if (operations.includes("op_underfunded")) {
        lines.push(
          "You need enough XLM for the payment, the network fee, and the minimum reserve your account must keep.",
        );
      }
    }
  }
  if (typeof extras?.reason === "string" && extras.reason.trim()) {
    lines.push(extras.reason.trim());
  }
  if (lines.length) {
    return [...new Set(lines)].join(" — ");
  }
  return err.message;
}

export async function buildPaymentXdr(params: {
  sourcePublicKey: string;
  destination: string;
  amount: string;
}): Promise<string> {
  const { sourcePublicKey, destination, amount } = params;
  if (!isValidPublicKey(destination)) {
    throw new Error("Invalid destination address.");
  }
  if (destination === sourcePublicKey) {
    throw new Error("Destination cannot be the same as your account.");
  }

  const normalizedAmount = normalizeXlmAmount(amount);
  const amountStroops = lumensStringToStroops(normalizedAmount);

  const server = getHorizonServer();
  const [sourceAccount, baseFee, baseReserveStroops] = await Promise.all([
    server.loadAccount(sourcePublicKey),
    server.fetchBaseFee(),
    fetchBaseReserveStroops(server),
  ]);

  const native = sourceAccount.balances.find((b) => b.asset_type === "native");
  if (!native || native.asset_type !== "native") {
    throw new Error("No native XLM balance on this account.");
  }
  const balanceStroops = lumensStringToStroops(native.balance);
  const feeStroops = BigInt(baseFee);
  const minSourceAfterTx = accountMinBalanceStroops(
    sourceAccount.subentry_count,
    baseReserveStroops,
  );

  let destinationExists = true;
  try {
    await server.loadAccount(destination);
  } catch (e) {
    if (e instanceof NotFoundError) {
      destinationExists = false;
    } else {
      throw e;
    }
  }

  const builder = new TransactionBuilder(sourceAccount, {
    fee: String(baseFee),
    networkPassphrase: TESTNET_PASSPHRASE,
  });

  if (destinationExists) {
    const totalRequired = amountStroops + feeStroops + minSourceAfterTx;
    if (balanceStroops < totalRequired) {
      throw new Error(
        `Insufficient balance. Sending ${normalizedAmount} XLM needs at least ${stroopsToLumensDisplay(totalRequired)} XLM ` +
          `(amount + fee + minimum reserve you must keep, ~${stroopsToLumensDisplay(minSourceAfterTx)} XLM). ` +
          `Your balance is ${native.balance} XLM.`,
      );
    }
    builder.addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: normalizedAmount,
      }),
    );
  } else {
    const minStartStroops = BigInt(2) * BigInt(baseReserveStroops);
    if (amountStroops < minStartStroops) {
      throw new Error(
        `New accounts need a starting balance of at least ${stroopsToLumensDisplay(minStartStroops)} XLM on this network.`,
      );
    }
    const totalRequired = amountStroops + feeStroops + minSourceAfterTx;
    if (balanceStroops < totalRequired) {
      throw new Error(
        `Insufficient balance. Creating an account with ${normalizedAmount} XLM needs at least ${stroopsToLumensDisplay(totalRequired)} XLM ` +
          `(starting balance + fee + minimum reserve you must keep, ~${stroopsToLumensDisplay(minSourceAfterTx)} XLM). ` +
          `Your balance is ${native.balance} XLM.`,
      );
    }
    builder.addOperation(
      Operation.createAccount({
        destination,
        startingBalance: normalizedAmount,
      }),
    );
  }

  const tx = builder.setTimeout(600).build();
  return tx.toXDR();
}

export function parseSignedTransaction(signedTxXdr: string) {
  return TransactionBuilder.fromXDR(signedTxXdr, TESTNET_PASSPHRASE);
}

export function testnetTxExplorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}
