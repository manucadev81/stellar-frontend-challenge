import {
  Asset,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

export const TESTNET_PASSPHRASE = Networks.TESTNET;

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

export async function buildPaymentXdr(params: {
  sourcePublicKey: string;
  destination: string;
  amount: string;
}): Promise<string> {
  const { sourcePublicKey, destination, amount } = params;
  if (!isValidPublicKey(destination)) {
    throw new Error("Endereço de destino inválido.");
  }
  const server = getHorizonServer();
  const sourceAccount = await server.loadAccount(sourcePublicKey);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

export function parseSignedTransaction(signedTxXdr: string) {
  return TransactionBuilder.fromXDR(signedTxXdr, TESTNET_PASSPHRASE);
}

export function testnetTxExplorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}
