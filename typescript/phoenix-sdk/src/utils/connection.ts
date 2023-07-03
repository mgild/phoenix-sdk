import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { ZSTDDecoder } from "zstddec";

/**
 * Get market account data and clock data with zstd compression
 * @param marketKey The market address
 * @returns
 */
export const getConfirmedMarketsAndClockAccounts = async (
  connection: Connection,
  marketKeys: PublicKey[]
): Promise<Buffer[]> => {
  const rawAccounts = (
    await connection.getMultipleAccountsInfo(
      [...marketKeys, SYSVAR_CLOCK_PUBKEY],
      "confirmed"
    )
  ).map((account) => account?.data);
  if (!rawAccounts.every((account) => account !== undefined)) {
    throw new Error("Unable to get account data");
  }
  return rawAccounts as Buffer[];
};

/**
 * Get market account data and clock data with zstd compression
 * @param marketKey The market address
 * @returns
 */
export const getConfirmedMarketsAndClockAccountsZstd = async (
  connection: Connection,
  marketKeys: PublicKey[]
): Promise<Buffer[]> => {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [
      [...marketKeys.map((m) => m.toBase58()), SYSVAR_CLOCK_PUBKEY.toBase58()],
      {
        encoding: "base64+zstd",
        commitment: "confirmed",
      },
    ],
  };

  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const values = (await response.json()).result.value;

  const decoder = new ZSTDDecoder();
  await decoder.init();
  const compressedClockData = Buffer.from(values.pop()?.data[0], "base64");
  if (compressedClockData === undefined) {
    throw new Error("Unable to get clock account data");
  }
  const clockBuffer = Buffer.from(decoder.decode(compressedClockData));

  const markets: Buffer[] = [];
  for (const payload of values) {
    if (payload?.data[0] === undefined) {
      throw new Error("Unable to get market account data");
    }
    const compressedMarketData = Buffer.from(payload.data[0], "base64");
    const marketBuffer = Buffer.from(
      decoder.decode(compressedMarketData, 1 << 23)
    );
    markets.push(marketBuffer);
  }
  return [...markets, clockBuffer];
};

/**
 * Get market account data with zstd compression
 * @param marketKey The market address
 * @returns
 */
export const getConfirmedMarketAccountZstd = async (
  connection: Connection,
  marketKey: PublicKey
): Promise<Buffer> => {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [
      marketKey.toBase58(),
      {
        encoding: "base64+zstd",
        commitment: "confirmed",
      },
    ],
  };

  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const value = (await response.json()).result.value;
  if (value?.data[0] === undefined) {
    throw new Error("Unable to get market account data");
  }

  const compressedMarketData = Buffer.from(value?.data[0], "base64");
  const decoder = new ZSTDDecoder();
  await decoder.init();
  const marketBuffer = decoder.decode(compressedMarketData, 1 << 23);
  return Buffer.from(marketBuffer);
};