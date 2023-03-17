import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import * as beet from "@metaplex-foundation/beet";

import {
  marketHeaderBeet,
  OrderPacket,
  SelfTradeBehavior,
  Side,
} from "../types";
import { createSwapInstruction } from "../instructions";
import { sign, toBN, toNum } from "./numbers";
import {
  orderIdBeet,
  publicKeyBeet,
  restingOrderBeet,
  traderStateBeet,
} from "./beet";
import { L3Book, L3Order, L3UiBook, L3UiOrder, OrderId, PROGRAM_ID } from "..";
import { Ladder, UiLadder, MarketData, TraderState } from "../market";

// Default ladder depth to use when fetching L2 ladder
export const DEFAULT_L2_LADDER_DEPTH = 10;

// Default book depth tho use when fetching L3 book
export const DEFAULT_L3_BOOK_DEPTH = 20;

export const DEFAULT_MATCH_LIMIT = 2048;
export const DEFAULT_SLIPPAGE_PERCENT = 0.005;

/**
 * Deserializes market data from a given buffer and returns a `MarketData` object
 *
 * @param data The data buffer to deserialize
 */
export function deserializeMarketData(data: Buffer): MarketData {
  // Deserialize the market header
  let offset = marketHeaderBeet.byteSize;
  const [header] = marketHeaderBeet.deserialize(data.subarray(0, offset));

  // Parse market data
  const paddingLen = 8 * 32;
  let remaining = data.subarray(offset + paddingLen);
  offset = 0;
  const baseLotsPerBaseUnit = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  const quoteLotsPerBaseUnitPerTick = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  const sequenceNumber = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  const takerFeeBps = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  const collectedQuoteLotFees = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  const unclaimedQuoteLotFees = Number(remaining.readBigUInt64LE(offset));
  offset += 8;
  remaining = remaining.subarray(offset);

  // Parse bids, asks and traders
  const numBids = toNum(header.marketSizeParams.bidsSize);
  const numAsks = toNum(header.marketSizeParams.asksSize);
  const numTraders = toNum(header.marketSizeParams.numSeats);

  const bidsSize =
    16 + 16 + (16 + orderIdBeet.byteSize + restingOrderBeet.byteSize) * numBids;
  const asksSize =
    16 + 16 + (16 + orderIdBeet.byteSize + restingOrderBeet.byteSize) * numAsks;
  const tradersSize =
    16 + 16 + (16 + 32 + traderStateBeet.byteSize) * numTraders;
  offset = 0;

  const bidBuffer = remaining.subarray(offset, offset + bidsSize);
  offset += bidsSize;
  const askBuffer = remaining.subarray(offset, offset + asksSize);
  offset += asksSize;
  const traderBuffer = remaining.subarray(offset, offset + tradersSize);

  const bidsUnsorted = deserializeRedBlackTree(
    bidBuffer,
    orderIdBeet,
    restingOrderBeet
  );

  const asksUnsorted = deserializeRedBlackTree(
    askBuffer,
    orderIdBeet,
    restingOrderBeet
  );

  // Sort bids in descending order of price, and ascending order of sequence number
  const bids = [...bidsUnsorted].sort((a, b) => {
    const priceComparison = sign(
      toBN(b[0].priceInTicks).sub(toBN(a[0].priceInTicks))
    );
    if (priceComparison !== 0) {
      return priceComparison;
    }
    return sign(
      getUiOrderSequenceNumber(a[0]).sub(getUiOrderSequenceNumber(b[0]))
    );
  });

  // Sort asks in ascending order of price, and ascending order of sequence number
  const asks = [...asksUnsorted].sort((a, b) => {
    const priceComparison = sign(
      toBN(a[0].priceInTicks).sub(toBN(b[0].priceInTicks))
    );
    if (priceComparison !== 0) {
      return priceComparison;
    }
    return sign(
      getUiOrderSequenceNumber(a[0]).sub(getUiOrderSequenceNumber(b[0]))
    );
  });

  const traders = new Map<string, TraderState>();
  for (const [k, traderState] of deserializeRedBlackTree(
    traderBuffer,
    publicKeyBeet,
    traderStateBeet
  )) {
    traders.set(k.publicKey.toString(), traderState);
  }

  const traderPubkeyToTraderIndex = new Map<string, number>();
  const traderIndexToTraderPubkey = new Map<number, string>();
  for (const [k, index] of getNodeIndices(
    traderBuffer,
    publicKeyBeet,
    traderStateBeet
  )) {
    traderPubkeyToTraderIndex.set(k.publicKey.toString(), index);
    traderIndexToTraderPubkey.set(index, k.publicKey.toString());
  }

  return {
    header,
    baseLotsPerBaseUnit,
    quoteLotsPerBaseUnitPerTick,
    sequenceNumber,
    takerFeeBps,
    collectedQuoteLotFees,
    unclaimedQuoteLotFees,
    bids,
    asks,
    traders,
    traderPubkeyToTraderIndex,
    traderIndexToTraderPubkey,
  };
}

/**
 * Deserializes a RedBlackTree from a given buffer
 * @description This deserialized the RedBlackTree defined in the sokoban library: https://github.com/Ellipsis-Labs/sokoban/tree/master
 *
 * @param data The data buffer to deserialize
 * @param keyDeserializer The deserializer for the tree key
 * @param valueDeserializer The deserializer for the tree value
 */
function deserializeRedBlackTree<Key, Value>(
  data: Buffer,
  keyDeserializer: beet.BeetArgsStruct<Key>,
  valueDeserializer: beet.BeetArgsStruct<Value>
): Map<Key, Value> {
  const tree = new Map<Key, Value>();
  const treeNodes = deserializeRedBlackTreeNodes(
    data,
    keyDeserializer,
    valueDeserializer
  );

  const nodes = treeNodes[0];
  const freeNodes = treeNodes[1];

  for (const [index, [key, value]] of nodes.entries()) {
    if (!freeNodes.has(index)) {
      tree.set(key, value);
    }
  }

  return tree;
}

/**
 * Deserializes the RedBlackTree to return a map of keys to indices
 *
 * @param data The trader data buffer to deserialize
 * @param keyDeserializer The deserializer for the tree key
 * @param valueDeserializer The deserializer for the tree value
 */
function getNodeIndices<Key, Value>(
  data: Buffer,
  keyDeserializer: beet.BeetArgsStruct<Key>,
  valueDeserializer: beet.BeetArgsStruct<Value>
): Map<Key, number> {
  const indexMap = new Map<Key, number>();
  const treeNodes = deserializeRedBlackTreeNodes(
    data,
    keyDeserializer,
    valueDeserializer
  );

  const nodes = treeNodes[0];
  const freeNodes = treeNodes[1];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [index, [key]] of nodes.entries()) {
    if (!freeNodes.has(index)) {
      indexMap.set(key, index + 1);
    }
  }

  return indexMap;
}

/**
 * Takes a raw order ID and returns a displayable order sequence number
 *
 * On the raw order book, sequence numbers are stored as unsigned 64-bit integers,
 * with bits inverted for bids and left as-is for asks. This function converts
 * the raw order ID to a signed 64-bit integer, and then converts it to a
 * displayable order sequence number.
 *
 * @param orderId
 */
export function getUiOrderSequenceNumber(orderId: OrderId): BN {
  const twosComplement = (orderId.orderSequenceNumber as BN).fromTwos(64);
  return twosComplement.isNeg()
    ? twosComplement.neg().sub(new BN(1))
    : twosComplement;
}

/**
 * Deserializes a RedBlackTree from a given buffer and returns the nodes and free nodes
 * @description This deserializes the RedBlackTree defined in the sokoban library: https://github.com/Ellipsis-Labs/sokoban/tree/master
 *
 * @param data The data buffer to deserialize
 * @param keyDeserializer The deserializer for the tree key
 * @param valueDeserializer The deserializer for the tree value
 */
function deserializeRedBlackTreeNodes<Key, Value>(
  data: Buffer,
  keyDeserializer: beet.BeetArgsStruct<Key>,
  valueDeserializer: beet.BeetArgsStruct<Value>
): [Array<[Key, Value]>, Set<number>] {
  let offset = 0;
  const keySize = keyDeserializer.byteSize;
  const valueSize = valueDeserializer.byteSize;

  const nodes = new Array<[Key, Value]>();

  // Skip RBTree header
  offset += 16;

  // Skip node allocator size
  offset += 8;
  const bumpIndex = data.readInt32LE(offset);
  offset += 4;
  let freeListHead = data.readInt32LE(offset);
  offset += 4;

  const freeListPointers = new Array<[number, number]>();

  for (let index = 0; offset < data.length && index < bumpIndex - 1; index++) {
    const registers = new Array<number>();
    for (let i = 0; i < 4; i++) {
      registers.push(data.readInt32LE(offset)); // skip padding
      offset += 4;
    }
    const [key] = keyDeserializer.deserialize(
      data.subarray(offset, offset + keySize)
    );
    offset += keySize;
    const [value] = valueDeserializer.deserialize(
      data.subarray(offset, offset + valueSize)
    );
    offset += valueSize;
    nodes.push([key, value]);
    freeListPointers.push([index, registers[0]]);
  }
  const freeNodes = new Set<number>();
  let indexToRemove = freeListHead - 1;

  let counter = 0;
  // If there's an infinite loop here, that means that the state is corrupted
  while (freeListHead < bumpIndex) {
    // We need to subtract 1 because the node allocator is 1-indexed
    const next = freeListPointers[freeListHead - 1];
    [indexToRemove, freeListHead] = next;
    freeNodes.add(indexToRemove);
    counter += 1;
    if (counter > bumpIndex) {
      throw new Error("Infinite loop detected");
    }
  }

  return [nodes, freeNodes];
}

/**
 * Returns an L2 ladder of bids and asks for given `MarketData`
 * @description Bids are ordered in descending order by price, and asks are ordered in ascending order by price
 *
 * @param marketData The `MarketData` to get the ladder from
 * @param slot The current slot
 * @param unixTimestamp The current Unix timestamp, in seconds
 * @param levels The number of book levels to return, -1 to return the entire book
 */
export function getMarketLadder(
  marketData: MarketData,
  slot: beet.bignum,
  unixTimestamp: beet.bignum,
  levels: number = DEFAULT_L2_LADDER_DEPTH
): Ladder {
  const bids: Array<[BN, BN]> = [];
  const asks: Array<[BN, BN]> = [];
  for (const [orderId, restingOrder] of marketData.bids) {
    if (restingOrder.lastValidSlot != 0 && restingOrder.lastValidSlot < slot) {
      continue;
    }
    if (
      restingOrder.lastValidUnixTimestampInSeconds != 0 &&
      restingOrder.lastValidUnixTimestampInSeconds < unixTimestamp
    ) {
      continue;
    }
    const priceInTicks = toBN(orderId.priceInTicks);
    const numBaseLots = toBN(restingOrder.numBaseLots);
    if (bids.length === 0) {
      bids.push([priceInTicks, numBaseLots]);
    } else {
      const prev = bids[bids.length - 1];
      if (!prev) {
        throw Error;
      }
      if (priceInTicks.eq(prev[0])) {
        prev[1] = prev[1].add(numBaseLots);
      } else {
        if (bids.length === levels) {
          break;
        }
        bids.push([priceInTicks, numBaseLots]);
      }
    }
  }

  for (const [orderId, restingOrder] of marketData.asks) {
    if (restingOrder.lastValidSlot != 0 && restingOrder.lastValidSlot < slot) {
      continue;
    }
    if (
      restingOrder.lastValidUnixTimestampInSeconds != 0 &&
      restingOrder.lastValidUnixTimestampInSeconds < unixTimestamp
    ) {
      continue;
    }
    const priceInTicks = toBN(orderId.priceInTicks);
    const numBaseLots = toBN(restingOrder.numBaseLots);
    if (asks.length === 0) {
      asks.push([priceInTicks, numBaseLots]);
    } else {
      const prev = asks[asks.length - 1];
      if (!prev) {
        throw Error;
      }
      if (priceInTicks.eq(prev[0])) {
        prev[1] = prev[1].add(numBaseLots);
      } else {
        if (asks.length === levels) {
          break;
        }
        asks.push([priceInTicks, numBaseLots]);
      }
    }
  }

  return {
    asks,
    bids,
  };
}

/**
 * Converts a ladder level from BN to JS number representation
 *
 * @param marketData The `MarketData` the ladder was taken from
 * @param priceInTicks The price of the level in ticks
 * @param sizeInBaseLots The size of the level in base lots
 * @param quoteAtomsPerQuoteUnit The number of quote atoms per quote unit
 */
function levelToUiLevel(
  marketData: MarketData,
  priceInTicks: BN,
  sizeInBaseLots: BN,
  quoteAtomsPerQuoteUnit: number
): [number, number] {
  return [
    ((toNum(priceInTicks) / quoteAtomsPerQuoteUnit) *
      marketData.quoteLotsPerBaseUnitPerTick *
      toNum(marketData.header.quoteLotSize)) /
      marketData.header.rawBaseUnitsPerBaseUnit,
    (toNum(sizeInBaseLots) / marketData.baseLotsPerBaseUnit) *
      marketData.header.rawBaseUnitsPerBaseUnit,
  ];
}

/**
 * Returns the ladder of bids and asks as JS numbers for given `MarketData`
 *
 * @param marketData The `MarketData` to get the ladder from
 * @param levels The number of book levels to return
 */
export function getMarketUiLadder(
  marketData: MarketData,
  levels: number = DEFAULT_L2_LADDER_DEPTH,
  slot: beet.bignum = 0,
  unixTimestamp: beet.bignum = 0
): UiLadder {
  const ladder = getMarketLadder(marketData, slot, unixTimestamp, levels);

  const quoteAtomsPerQuoteUnit =
    10 ** toNum(marketData.header.quoteParams.decimals);
  return {
    bids: ladder.bids.map(([priceInTicks, sizeInBaseLots]) =>
      levelToUiLevel(
        marketData,
        priceInTicks,
        sizeInBaseLots,
        quoteAtomsPerQuoteUnit
      )
    ),
    asks: ladder.asks.map(([priceInTicks, sizeInBaseLots]) =>
      levelToUiLevel(
        marketData,
        priceInTicks,
        sizeInBaseLots,
        quoteAtomsPerQuoteUnit
      )
    ),
  };
}

/**
 * Pretty prints the market's ladder as a colored orderbook
 *
 * @param uiLadder The ladder (represented by JS numbers) to print
 */
export function printUiLadder(uiLadder: UiLadder) {
  const bids = uiLadder.bids;
  const asks = uiLadder.asks;

  const maxBaseSize = Math.max(
    ...bids.map((b) => b[1]),
    ...asks.map((a) => a[1])
  );
  const maxBaseSizeLength = maxBaseSize.toString().length;

  const printLine = (price: number, size: number, color: "red" | "green") => {
    const priceStr = price.toFixed(3);
    const sizeStr = size.toFixed(2).padStart(maxBaseSizeLength, " ");
    console.log(
      priceStr + `\u001b[3${color === "green" ? 2 : 1}m` + sizeStr + "\u001b[0m"
    );
  };
  // Reverse the asks so the display order is descending in price
  console.log("\u001b[30mAsks\u001b[0m");
  for (const [price, size] of asks.reverse()) {
    printLine(price, size, "red");
  }

  console.log("\u001b[30mBids\u001b[0m");
  for (const [price, size] of bids) {
    printLine(price, size, "green");
  }
}

/**
 * Returns the L3 book of bids and asks for a given `MarketData`.
 * @description Bids are ordered in descending order by price, and asks are ordered in ascending order by price
 *
 * @param marketData The `MarketData` to get the ladder from
 * @param slot The current slot
 * @param unixTimestamp The current Unix timestamp, in seconds
 * @param ordersPerSide The max number of orders to return per side. -1 to return the entire book
 */
export function getMarketL3Book(
  marketData: MarketData,
  slot: beet.bignum,
  unixTimestamp: beet.bignum,
  ordersPerSide: number = DEFAULT_L3_BOOK_DEPTH
): L3Book {
  const bids: L3Order[] = [];
  const asks: L3Order[] = [];
  for (const [orderId, restingOrder] of marketData.bids) {
    if (restingOrder.lastValidSlot != 0 && restingOrder.lastValidSlot < slot) {
      continue;
    }
    if (
      restingOrder.lastValidUnixTimestampInSeconds != 0 &&
      restingOrder.lastValidUnixTimestampInSeconds < unixTimestamp
    ) {
      continue;
    }
    const priceInTicks = toBN(orderId.priceInTicks);
    const numBaseLots = toBN(restingOrder.numBaseLots);

    bids.push({
      priceInTicks,
      sizeInBaseLots: numBaseLots,
      side: Side.Bid,
      makerPubkey: marketData.traderIndexToTraderPubkey.get(
        toNum(restingOrder.traderIndex)
      ),
      orderSequenceNumber: getUiOrderSequenceNumber(orderId),
    });

    if (bids.length === ordersPerSide) {
      break;
    }
  }

  for (const [orderId, restingOrder] of marketData.asks) {
    if (restingOrder.lastValidSlot != 0 && restingOrder.lastValidSlot < slot) {
      continue;
    }
    if (
      restingOrder.lastValidUnixTimestampInSeconds != 0 &&
      restingOrder.lastValidUnixTimestampInSeconds < unixTimestamp
    ) {
      continue;
    }
    const priceInTicks = toBN(orderId.priceInTicks);
    const numBaseLots = toBN(restingOrder.numBaseLots);

    asks.push({
      priceInTicks,
      sizeInBaseLots: numBaseLots,
      side: Side.Ask,
      makerPubkey: marketData.traderIndexToTraderPubkey.get(
        toNum(restingOrder.traderIndex)
      ),
      orderSequenceNumber: getUiOrderSequenceNumber(orderId),
    });

    if (asks.length === ordersPerSide) {
      break;
    }
  }

  return {
    asks,
    bids,
  };
}

/**
 * Returns the L3 book of bids and asks as JS numbers
 *
 * @param marketData The `MarketData` to get the ladder from
 * @param levels The number of book levels to return
 */
export function getMarketL3UiBook(
  marketData: MarketData,
  ordersPerSide: number = DEFAULT_L3_BOOK_DEPTH,
  slot: beet.bignum = 0,
  unixTimestamp: beet.bignum = 0
): L3UiBook {
  const l3Book = getMarketL3Book(
    marketData,
    slot,
    unixTimestamp,
    ordersPerSide
  );

  return {
    bids: l3Book.bids.map((b) => getL3UiOrder(b, marketData)),
    asks: l3Book.asks.map((a) => getL3UiOrder(a, marketData)),
  };
}

/**
 * Converts a L3 order from BN to JS number representation
 *
 * @param l3Order The L3 order to convert
 * @param marketData The `MarketData` the order was taken from
 */
function getL3UiOrder(l3Order: L3Order, marketData: MarketData): L3UiOrder {
  return {
    price:
      (toNum(l3Order.priceInTicks) *
        marketData.quoteLotsPerBaseUnitPerTick *
        toNum(marketData.header.quoteLotSize)) /
      (10 ** marketData.header.quoteParams.decimals *
        marketData.header.rawBaseUnitsPerBaseUnit),
    side: l3Order.side,
    size:
      (toNum(l3Order.sizeInBaseLots) *
        marketData.header.rawBaseUnitsPerBaseUnit) /
      marketData.baseLotsPerBaseUnit,
    makerPubkey: l3Order.makerPubkey,
    orderSequenceNumber: l3Order.orderSequenceNumber.toString(),
  };
}

/**
 * Returns a Phoenix swap transaction
 *
 * @param marketAddress The address of the market to swap in
 * @param marketData The `MarketData` for the swap market
 * @param trader The `PublicKey` of the trader
 * @param side The side of the order to place (Bid, Ask)
 * @param inAmount The amount (in whole tokens) of the input token to swap
 * @param slippage The slippage tolerance (optional, default 0.5%)
 * @param clientOrderId The client order ID (optional)
 */
export function getMarketSwapTransaction({
  marketAddress,
  marketData,
  trader,
  side,
  inAmount,
  slippage = DEFAULT_SLIPPAGE_PERCENT,
  clientOrderId = 0,
}: {
  marketAddress: PublicKey;
  marketData: MarketData;
  trader: PublicKey;
  side: Side;
  inAmount: number;
  slippage?: number;
  clientOrderId?: number;
}): Transaction {
  const baseAccount = PublicKey.findProgramAddressSync(
    [
      trader.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      marketData.header.baseParams.mintKey.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
  const quoteAccount = PublicKey.findProgramAddressSync(
    [
      trader.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      marketData.header.quoteParams.mintKey.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
  const logAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("log")],
    PROGRAM_ID
  )[0];

  const orderAccounts = {
    phoenixProgram: PROGRAM_ID,
    logAuthority,
    market: marketAddress,
    trader,
    baseAccount,
    quoteAccount,
    quoteVault: marketData.header.quoteParams.vaultKey,
    baseVault: marketData.header.baseParams.vaultKey,
  };

  const orderPacket = getMarketSwapOrderPacket({
    marketData,
    side,
    inAmount,
    slippage,
    clientOrderId,
  });

  const ix = createSwapInstruction(orderAccounts, {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TODO why is __kind incompatible?
    orderPacket: {
      __kind: "ImmediateOrCancel",
      ...orderPacket,
    },
  });

  return new Transaction().add(ix);
}

/**
 * Returns a Phoenix swap order packet
 *
 * @param marketData The `MarketData` for the swap market
 * @param side The side of the order
 * @param inAmount The amount of the input token
 * @param slippage The slippage tolerance in bps (optional, default 0.5%)
 * @param selfTradeBehavior The self trade behavior (optional, default Abort)
 * @param matchLimit The match limit (optional)
 * @param clientOrderId The client order ID (optional)
 * @param useOnlyDepositedFunds Whether to use only deposited funds (optional)
 */
export function getMarketSwapOrderPacket({
  marketData,
  side,
  inAmount,
  slippage = DEFAULT_SLIPPAGE_PERCENT,
  selfTradeBehavior = SelfTradeBehavior.Abort,
  matchLimit = DEFAULT_MATCH_LIMIT,
  clientOrderId = 0,
  useOnlyDepositedFunds = false,
}: {
  marketData: MarketData;
  side: Side;
  inAmount: number;
  slippage?: number;
  selfTradeBehavior?: SelfTradeBehavior;
  matchLimit?: number;
  clientOrderId?: number;
  useOnlyDepositedFunds?: boolean;
}): Partial<OrderPacket> {
  const numBids = toNum(marketData.header.marketSizeParams.bidsSize);
  const numAsks = toNum(marketData.header.marketSizeParams.asksSize);
  const ladder = getMarketUiLadder(marketData, Math.max(numBids, numAsks));
  const expectedOutAmount = getMarketExpectedOutAmount({
    ladder,
    takerFeeBps: marketData.takerFeeBps,
    side,
    inAmount,
  });
  const baseMul = 10 ** marketData.header.baseParams.decimals;
  const quoteMul = 10 ** marketData.header.quoteParams.decimals;
  const slippageDenom = 1 - slippage;
  let numBaseLots = 0;
  let minBaseLotsToFill = 0;
  let numQuoteLots = 0;
  let minQuoteLotsToFill = 0;

  if (side === Side.Ask) {
    numBaseLots =
      (inAmount * baseMul) /
      parseFloat(marketData.header.baseLotSize.toString());
    minQuoteLotsToFill = Math.ceil(
      ((expectedOutAmount * quoteMul) /
        parseFloat(marketData.header.quoteLotSize.toString())) *
        slippageDenom
    );
  } else {
    numQuoteLots =
      (inAmount * quoteMul) /
      parseFloat(marketData.header.quoteLotSize.toString());
    minBaseLotsToFill = Math.ceil(
      ((expectedOutAmount * baseMul) /
        parseFloat(marketData.header.baseLotSize.toString())) *
        slippageDenom
    );
  }

  const orderPacket: Partial<OrderPacket> = {
    side,
    priceInTicks: null,
    numBaseLots,
    minBaseLotsToFill,
    numQuoteLots,
    minQuoteLotsToFill,
    selfTradeBehavior,
    matchLimit,
    clientOrderId,
    useOnlyDepositedFunds,
    lastValidSlot: null,
    lastValidUnixTimestampInSeconds: null,
  };

  return orderPacket;
}

/**
 * Returns a Phoenix swap order packet
 *
 * @param marketData The `MarketData` for the swap market
 * @param side The side of the order
 * @param inAmount The amount of the input token
 * @param lastValidSlot The last valid slot for the order, if null, the order is valid until cancelled
 * @param lastValidUnixTimestampInSeconds The last valid unix timestamp in seconds for the order, if null, the order is valid until cancelled
 * @param slippage The slippage tolerance in bps (optional, default 0.5%)
 * @param selfTradeBehavior The self trade behavior (optional, default Abort)
 * @param matchLimit The match limit (optional)
 * @param clientOrderId The client order ID (optional)
 * @param useOnlyDepositedFunds Whether to use only deposited funds (optional)
 */
export function getMarketSwapOrderPacketWithTimeInForce({
  marketData,
  side,
  inAmount,
  lastValidSlot,
  lastValidUnixTimestampInSeconds,
  slippage = DEFAULT_SLIPPAGE_PERCENT,
  selfTradeBehavior = SelfTradeBehavior.Abort,
  matchLimit = DEFAULT_MATCH_LIMIT,
  clientOrderId = 0,
  useOnlyDepositedFunds = false,
}: {
  marketData: MarketData;
  side: Side;
  inAmount: number;
  lastValidSlot: number | null;
  lastValidUnixTimestampInSeconds: number | null;
  slippage?: number;
  selfTradeBehavior?: SelfTradeBehavior;
  matchLimit?: number;
  clientOrderId?: number;
  useOnlyDepositedFunds?: boolean;
}): Partial<OrderPacket> {
  const orderPacket = getMarketSwapOrderPacket({
    marketData,
    side,
    inAmount,
    slippage,
    selfTradeBehavior,
    matchLimit,
    clientOrderId,
    useOnlyDepositedFunds,
  });
  orderPacket.lastValidSlot = lastValidSlot;
  orderPacket.lastValidUnixTimestampInSeconds = lastValidUnixTimestampInSeconds;
  return orderPacket;
}

/**
 * Returns the expected amount out for a given swap order
 *
 * @param marketData The `MarketData` for the swap market
 * @param side The side of the order (Bid or Ask)
 * @param inAmount The amount of the input token
 *
 * TODO this should use getMarketLadder and adjust its calculation
 */
export function getMarketExpectedOutAmount({
  ladder,
  takerFeeBps,
  side,
  inAmount,
}: {
  ladder: UiLadder;
  takerFeeBps: number;
  side: Side;
  inAmount: number;
}): number {
  let remainingUnits = inAmount * (1 - takerFeeBps / 10000);
  let expectedUnitsReceived = 0;
  if (side === Side.Bid) {
    for (const [priceInQuoteUnitsPerBaseUnit, sizeInBaseUnits] of ladder.asks) {
      const totalQuoteUnitsAvailable =
        sizeInBaseUnits * priceInQuoteUnitsPerBaseUnit;
      if (totalQuoteUnitsAvailable > remainingUnits) {
        expectedUnitsReceived += remainingUnits / priceInQuoteUnitsPerBaseUnit;
        remainingUnits = 0;
        break;
      } else {
        expectedUnitsReceived += sizeInBaseUnits;
        remainingUnits -= totalQuoteUnitsAvailable;
      }
    }
  } else {
    for (const [priceInQuoteUnitsPerBaseUnit, sizeInBaseUnits] of ladder.bids) {
      if (sizeInBaseUnits > remainingUnits) {
        expectedUnitsReceived += remainingUnits * priceInQuoteUnitsPerBaseUnit;
        remainingUnits = 0;
        break;
      } else {
        expectedUnitsReceived += sizeInBaseUnits * priceInQuoteUnitsPerBaseUnit;
        remainingUnits -= sizeInBaseUnits;
      }
    }
  }

  return expectedUnitsReceived;
}
