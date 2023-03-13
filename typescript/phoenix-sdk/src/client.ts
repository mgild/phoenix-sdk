import {
  AccountInfo,
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { deserialize } from "borsh";
import { getClusterFromEndpoint, toNum } from "./utils";
import { Token } from "./token";
import { Market } from "./market";
import { Trader } from "./trader";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Clock,
  ClockSchema,
  DEFAULT_LADDER_DEPTH,
  Ladder,
  PROGRAM_ID,
  Side,
  UiLadder,
  getMarketLadder,
  getMarketUiLadder,
  printUiLadder,
} from "./index";
import axios from "axios";

export type TokenConfig = {
  name: string;
  symbol: string;
  mint: string;
  logoUri: string;
};

export class Client {
  connection: Connection;
  trader: Trader;
  tokenConfig: Array<TokenConfig>;
  tokens: Array<Token>;
  markets: Map<string, Market>;
  clock: Clock;

  private constructor({
    connection,
    tokens,
    tokenConfig,
    markets,
    trader,
    clock,
  }: {
    connection: Connection;
    tokens: Array<Token>;
    tokenConfig: Array<TokenConfig>;
    markets: Map<string, Market>;
    trader?: Trader;
    clock?: Clock;
  }) {
    this.connection = connection;
    this.tokens = tokens;
    this.tokenConfig = tokenConfig;
    this.markets = markets;
    this.trader = trader;
    this.clock = clock;
  }

  static async loadMarketsAndTokens(
    marketKeysToData: Array<[PublicKey, AccountInfo<Buffer>]>,
    tokenConfig: Array<TokenConfig>
  ): Promise<[Map<string, Market>, Token[]]> {
    const tokens = [];
    const markets = new Map();
    await Promise.all(
      // For every market:
      marketKeysToData.map(async ([marketAddress, marketAccount]) => {
        // Load the market
        const market = await Market.load({
          address: marketAddress,
          buffer: marketAccount.data,
          tokenList: tokenConfig,
        });

        markets.set(marketAddress.toString(), market);

        // Set the tokens from the market (avoiding duplicates)
        for (const token of [market.baseToken, market.quoteToken]) {
          const mint = token.data.mintKey.toBase58();
          if (tokens.find((t) => t.data.mintKey.toBase58() === mint)) continue;
          tokens.push(token);
        }
      })
    );
    return [markets, tokens];
  }

  /**
   * Creates a new `PhoenixClient`
   *
   * @param connection The Solana `Connection` to use for the client
   * @param endpoint Solana cluster to use - "mainnet", "devnet", or "localnet"
   * @param trader The `PublicKey` of the trader account to use for the client (optional)
   */
  static async create(
    connection: Connection,
    endpoint: string,
    trader?: PublicKey
  ): Promise<Client> {
    const cluster = getClusterFromEndpoint(endpoint);
    const config_url =
      "https://raw.githubusercontent.com/Ellipsis-Labs/phoenix-sdk/master/typescript/phoenix-sdk/config.json";

    const marketConfigs = await axios.get(config_url).then((response) => {
      return response.data;
    });

    const marketAddresses: PublicKey[] = marketConfigs[cluster].markets.map(
      (marketAddress: string) => {
        return new PublicKey(marketAddress);
      }
    );

    const tokenConfig = marketConfigs[cluster].tokens;

    const accounts = await connection.getMultipleAccountsInfo(
      [...marketAddresses, SYSVAR_CLOCK_PUBKEY],
      "confirmed"
    );

    const clockBuffer = accounts.pop().data;

    const clock = deserialize(ClockSchema, Clock, clockBuffer);
    const marketKeysToData: Array<[PublicKey, AccountInfo<Buffer>]> =
      marketAddresses.map((marketAddress, index) => {
        return [marketAddress, accounts[index]];
      });

    const [markets, tokens] = await Client.loadMarketsAndTokens(
      marketKeysToData,
      tokenConfig
    );

    return new Client({
      connection,
      tokens,
      markets,
      tokenConfig,
      trader: trader
        ? await Trader.create({
            connection,
            pubkey: trader,
            tokens,
          })
        : undefined,
      clock,
    });
  }

  static async createWithMarketAddresses(
    connection: Connection,
    endpoint: string,
    marketAddresses: PublicKey[],
    trader?: PublicKey
  ): Promise<Client> {
    const cluster = getClusterFromEndpoint(endpoint);
    const config_url =
      "https://raw.githubusercontent.com/Ellipsis-Labs/phoenix-sdk/master/typescript/phoenix-sdk/config.json";

    const marketConfigs = await axios.get(config_url).then((response) => {
      return response.data;
    });
    const tokenConfig = marketConfigs[cluster].tokens;
    const accounts = await connection.getMultipleAccountsInfo(
      [...marketAddresses, SYSVAR_CLOCK_PUBKEY],
      "confirmed"
    );

    const clock = deserialize(ClockSchema, Clock, accounts.pop().data);

    const marketKeysToData: Array<[PublicKey, AccountInfo<Buffer>]> =
      marketAddresses.map((marketAddress, index) => {
        return [marketAddress, accounts[index]];
      });

    const [markets, tokens] = await Client.loadMarketsAndTokens(
      marketKeysToData,
      tokenConfig
    );

    return new Client({
      connection,
      tokens,
      markets,
      tokenConfig,
      trader: trader
        ? await Trader.create({
            connection,
            pubkey: trader,
            tokens,
          })
        : undefined,
      clock,
    });
  }

  /**
   * Add a market to the client. Useful for localnet as markets will not be loaded in by default.
   * @param marketAddress The `PublicKey` of the market account
   * @param forceReload If this is set to true, it will reload the market even if it already exists
   *
   */
  public async addMarket(marketAddress: string, forceReload = false) {
    const existingMarket = this.markets.get(marketAddress);

    // If the market already exists, return
    if (existingMarket !== undefined) {
      if (forceReload) {
        await this.refreshMarket(marketAddress);
      } else {
        console.log("Market already exists: ", marketAddress);
      }
      return;
    }

    const marketKey = new PublicKey(marketAddress);
    const accounts = await this.connection.getMultipleAccountsInfo(
      [marketKey, SYSVAR_CLOCK_PUBKEY],
      "confirmed"
    );
    if (accounts.length !== 2)
      throw new Error("Account not found for market: " + marketKey.toBase58());

    const buffer = Buffer.from(accounts[0].data);

    const market = await Market.load({
      address: marketKey,
      buffer,
      tokenList: this.tokenConfig,
    });
    for (const token of [market.baseToken, market.quoteToken]) {
      const mint = token.data.mintKey.toBase58();
      if (this.tokens.find((t) => t.data.mintKey.toBase58() === mint)) continue;
      this.tokens.push(token);
    }
    this.markets.set(marketAddress, market);
    this.reloadClockFromBuffer(Buffer.from(accounts[1].data));
  }

  /**
   * Refreshes the market data and clock
   *
   * @param marketAddress The address of the market to refresh
   *
   * @returns The refreshed Market
   */
  public async refreshMarket(
    marketAddress: string | PublicKey
  ): Promise<Market> {
    const marketKey = new PublicKey(marketAddress);
    const existingMarket = this.markets.get(marketKey.toString());
    if (existingMarket === undefined) {
      throw new Error("Market does not exist: " + marketKey.toBase58());
    }
    const accounts = await this.connection.getMultipleAccountsInfo(
      [marketKey, SYSVAR_CLOCK_PUBKEY],
      "confirmed"
    );
    if (accounts.length !== 2)
      throw new Error("Account not found for market: " + marketKey.toBase58());

    const buffer = Buffer.from(accounts[0].data);
    existingMarket.reload(buffer);
    this.reloadClockFromBuffer(Buffer.from(accounts[1].data));

    return existingMarket;
  }

  public async reloadClock() {
    const clockAccount = await this.connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );
    this.reloadClockFromBuffer(clockAccount.data);
  }

  reloadClockFromBuffer(clockBuffer: Buffer) {
    this.clock = deserialize(ClockSchema, Clock, clockBuffer);
  }

  /**
   * Returns the market's ladder of bids and asks
   * @param marketAddress The `PublicKey` of the market account
   */
  public getLadder(
    marketAddress: string,
    levels: number = DEFAULT_LADDER_DEPTH
  ): Ladder {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return getMarketLadder(
      market.data,
      this.clock.slot,
      this.clock.unixTimestamp,
      levels
    );
  }

  /**
   * Returns the market's ladder of bids and asks  as JS numbers
   * @param marketAddress The `PublicKey` of the market account
   */
  public getUiLadder(
    marketAddress: string,
    levels: number = DEFAULT_LADDER_DEPTH
  ): UiLadder {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return getMarketUiLadder(
      market.data,
      levels,
      this.clock.slot,
      this.clock.unixTimestamp
    );
  }

  /**
   * Pretty prints the market's current ladder of bids and asks
   */
  public printLadder(marketAddress: string) {
    printUiLadder(this.getUiLadder(marketAddress));
  }

  /**
   * Returns the expected amount out for a given swap order
   *
   * @param marketAddress The `MarketAddress` for the swap market
   * @param side The side of the order (Bid or Ask)
   * @param inAmount The amount of the input token
   *
   * TODO this should use getMarketLadder and adjust its calculation
   */
  public getMarketExpectedOutAmount({
    marketAddress,
    side,
    inAmount,
  }: {
    marketAddress: string;
    side: Side;
    inAmount: number;
  }): number {
    const marketData = this.markets.get(marketAddress)?.data;
    const numBids = toNum(marketData.header.marketSizeParams.bidsSize);
    const numAsks = toNum(marketData.header.marketSizeParams.asksSize);
    const ladder = this.getUiLadder(marketAddress, Math.max(numBids, numAsks));

    let remainingUnits = inAmount * (1 - marketData.takerFeeBps / 10000);
    let expectedUnitsReceived = 0;
    if (side === Side.Bid) {
      for (const [
        priceInQuoteUnitsPerBaseUnit,
        sizeInBaseUnits,
      ] of ladder.asks) {
        const totalQuoteUnitsAvailable =
          sizeInBaseUnits * priceInQuoteUnitsPerBaseUnit;
        if (totalQuoteUnitsAvailable > remainingUnits) {
          expectedUnitsReceived +=
            remainingUnits / priceInQuoteUnitsPerBaseUnit;
          remainingUnits = 0;
          break;
        } else {
          expectedUnitsReceived += sizeInBaseUnits;
          remainingUnits -= totalQuoteUnitsAvailable;
        }
      }
    } else {
      for (const [
        priceInQuoteUnitsPerBaseUnit,
        sizeInBaseUnits,
      ] of ladder.bids) {
        if (sizeInBaseUnits > remainingUnits) {
          expectedUnitsReceived +=
            remainingUnits * priceInQuoteUnitsPerBaseUnit;
          remainingUnits = 0;
          break;
        } else {
          expectedUnitsReceived +=
            sizeInBaseUnits * priceInQuoteUnitsPerBaseUnit;
          remainingUnits -= sizeInBaseUnits;
        }
      }
    }

    return expectedUnitsReceived;
  }

  /**
   * Get the Pubkey for a trader's Base Token Account on Phoenix
   * @param trader The `PublicKey` of the trader account
   * @param marketAddress The `PublicKey` of the market account
   */
  public getBaseAccountKey(
    trader: PublicKey,
    marketAddress: string
  ): PublicKey {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return PublicKey.findProgramAddressSync(
      [
        trader.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        market.data.header.baseParams.mintKey.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
  }

  /**
   * Get the Pubkey for a trader's Quote Token Account on Phoenix
   * @param trader The `PublicKey` of the trader account
   * @param marketAddress The `PublicKey` of the market account
   */
  public getQuoteAccountKey(
    trader: PublicKey,
    marketAddress: string
  ): PublicKey {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return PublicKey.findProgramAddressSync(
      [
        trader.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        market.data.header.quoteParams.mintKey.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
  }

  /**
   * Get the Pubkey for a trader's Seat Account
   * @param trader The `PublicKey` of the trader account
   * @param marketAddress The `PublicKey` of the market account
   */
  public getSeatKey(trader: PublicKey, marketAddress: string): PublicKey {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    const marketPubkey = new PublicKey(marketAddress);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), marketPubkey.toBuffer(), trader.toBuffer()],
      PROGRAM_ID
    )[0];
  }

  /**
   * Get the Log Authority Pubkey
   */
  public getLogAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("log")],
      PROGRAM_ID
    )[0];
  }

  /**
   * Get the price in ticks for a given price
   * @param price The price to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public floatPriceToTicks(price: number, marketAddress: string): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return Math.round(
      (price * 10 ** market.quoteToken.data.decimals) /
        market.data.quoteLotsPerBaseUnitPerTick
    );
  }

  /**
   * Get the price in quote units for a given price in ticks
   * @param ticks  The price in ticks to convert
   * @param marketAddress  The `PublicKey` of the market account
   */
  public ticksToFloatPrice(ticks: number, marketAddress: string): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return (
      (ticks * market.data.quoteLotsPerBaseUnitPerTick) /
      10 ** market.quoteToken.data.decimals
    );
  }

  /**
   * Get the amount of base lots for a given amount of raw base units (rounded down)
   * @param rawBaseUnits The amount of raw base units to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public rawBaseUnitsToBaseLots(
    rawBaseUnits: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    const base_units =
      rawBaseUnits / market.data.header.rawBaseUnitsPerBaseUnit;
    return Math.floor(base_units * market.data.baseLotsPerBaseUnit);
  }

  /**
   * Get the amount of base lots for a given amount of raw base units (rounded up)
   * @param rawBaseUnits The amount of raw base units to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public rawBaseUnitsToBaseLotsRoundedUp(
    rawBaseUnits: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    const base_units =
      rawBaseUnits / market.data.header.rawBaseUnitsPerBaseUnit;
    return Math.ceil(base_units * market.data.baseLotsPerBaseUnit);
  }

  /**
   * Get the amount of base lots for a given amount base atoms
   * @param baseAtoms The amount of base atoms to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public baseAtomsToBaseLots(baseAtoms: number, marketAddress: string): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return Math.round(baseAtoms / toNum(market.data.header.baseLotSize));
  }

  /**
   * Get the amount of base atoms for a given amount of base lots
   * @param baseLots The amount of base lots to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public baseLotsToBaseAtoms(baseLots: number, marketAddress: string): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return baseLots * toNum(market.data.header.baseLotSize);
  }

  /**
   * Get the amount of quote lots for a given amount of quote units
   * @param quoteUnits The amount of quote units to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public quoteUnitsToQuoteLots(
    quoteUnits: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return Math.round(
      (quoteUnits * 10 ** market.quoteToken.data.decimals) /
        toNum(market.data.header.quoteLotSize)
    );
  }

  /**
   * Get the amount of quote lots for a given amount of quote atoms
   * @param quoteAtoms The amount of quote atoms to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public quoteAtomsToQuoteLots(
    quoteAtoms: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return Math.round(quoteAtoms / toNum(market.data.header.quoteLotSize));
  }

  /**
   * Get the amount of quote atoms for a given amount of quote lots
   * @param quoteLots The amount of quote lots to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public quoteLotsToQuoteAtoms(
    quoteLots: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return quoteLots * toNum(market.data.header.quoteLotSize);
  }

  /**
   * Get the amount of base units for a given amount of base atoms
   * @param baseAtoms The amount of base atoms to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public baseAtomsToBaseUnits(
    baseAtoms: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return baseAtoms / 10 ** market.baseToken.data.decimals;
  }

  /**
   * Get the amount of quote units for a given amount of quote atoms
   * @param quoteAtoms The amount of quote atoms to convert
   * @param marketAddress The `PublicKey` of the market account
   */
  public quoteAtomsToQuoteUnits(
    quoteAtoms: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return quoteAtoms / 10 ** market.quoteToken.data.decimals;
  }

  /**
   * Get the amount of quote atoms for an order with a given amount of base lots and a price in ticks
   * @param baseLots The amount of base lots to convert
   * @param price_in_ticks The price in ticks
   * @param marketAddress The `PublicKey` of the market account
   */
  public orderToQuoteAmount(
    baseLots: number,
    price_in_ticks: number,
    marketAddress: string
  ): number {
    const market = this.markets.get(marketAddress);
    if (!market) throw new Error("Market not found: " + marketAddress);
    return Math.round(
      (baseLots *
        price_in_ticks *
        toNum(market.data.header.tickSizeInQuoteAtomsPerBaseUnit)) /
        market.data.baseLotsPerBaseUnit
    );
  }
}
