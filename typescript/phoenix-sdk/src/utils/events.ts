import {
  Connection,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import { BinaryReader } from "borsh";
import base58 from "bs58";
import BN from "bn.js";
import * as beet from "@metaplex-foundation/beet";

import { PROGRAM_ID } from "../index";
import {
  AuditLogHeader,
  PhoenixMarketEvent,
  phoenixMarketEventBeet,
} from "../types";
import { logInstructionDiscriminator } from "../instructions";

export type PhoenixTransaction = {
  instructions: Array<PhoenixEventsFromInstruction>;
  txReceived: boolean;
  txFailed: boolean;
};

export type PhoenixEventsFromInstruction = {
  header: AuditLogHeader;
  events: Array<PhoenixMarketEvent>;
};

export type PhoenixEvents = {
  events: PhoenixMarketEvent[];
};

export const phoenixEventsBeet = new beet.FixableBeetArgsStruct<PhoenixEvents>(
  [["events", beet.array(phoenixMarketEventBeet)]],
  "PhoenixEvents"
);

export function decodePhoenixEvents(data: Uint8Array): PhoenixMarketEvent[] {
  const buffer: Buffer = Buffer.from(data);
  const [events] = phoenixEventsBeet.deserialize(buffer, 0);
  return events.events;
}

export function readPublicKey(reader: BinaryReader): PublicKey {
  return new PublicKey(reader.readFixedArray(32));
}

/**
 * Returns a list of Phoenix events for a given transaction object
 *
 * @param txData The transaction object returned by `getParsedTransaction` of type `ParsedTransactionWithMeta`
 */
export function getPhoenixEventsFromTransactionData(
  txData: ParsedTransactionWithMeta
): PhoenixTransaction {
  const meta = txData?.meta;
  if (meta === undefined) {
    console.log("Transaction not found");
    return { instructions: [], txReceived: false, txFailed: true };
  }

  if (meta?.err !== null) {
    console.log("Transaction failed", meta?.err);
    return { instructions: [], txReceived: true, txFailed: true };
  }

  const innerIxs = txData?.meta?.innerInstructions;
  if (!innerIxs || !txData || !txData.slot) {
    console.log("No inner instructions found");
    return { instructions: [], txReceived: true, txFailed: true };
  }

  const logData: Array<Uint8Array> = [];
  for (const ix of innerIxs) {
    for (const inner of ix.instructions) {
      if (inner.programId.toBase58() != PROGRAM_ID.toBase58()) {
        continue;
      }
      const rawData = base58.decode(
        (inner as PartiallyDecodedInstruction).data
      );
      if (rawData[0] == logInstructionDiscriminator) {
        logData.push(rawData.slice(1));
      }
    }
  }
  const instructions = new Array<PhoenixEventsFromInstruction>();

  for (const data of logData) {
    // Decode the header by hand
    const reader = new BinaryReader(Buffer.from(data));
    const byte = reader.readU8();
    // A byte of 1 identifies a header event
    if (byte != 1) {
      throw new Error("early Unexpected event");
    }
    const header = {
      instruction: reader.readU8(),
      sequenceNumber: reader.readU64(),
      timestamp: reader.readU64(),
      slot: reader.readU64(),
      market: readPublicKey(reader),
      signer: readPublicKey(reader),
      totalEvents: reader.readU16(),
    };

    const lengthPadding = new BN(header.totalEvents).toBuffer("le", 4);
    const events = decodePhoenixEvents(
      Buffer.concat([lengthPadding, Buffer.from(data.slice(reader.offset))])
    );

    instructions.push({
      header: header,
      events: events,
    });
  }
  return { instructions: instructions, txReceived: true, txFailed: false };
}

/**
 * Returns a list of Phoenix events for a given transaction signature
 *
 * @param connection The Solana `Connection` object
 * @param signature The signature of the transaction to fetch
 * @deprecated The method is deprecated. Please use `getPhoneixEventsFromTransactionSignature` instead
 */
export async function getEventsFromTransaction(
  connection: Connection,
  signature: string
): Promise<PhoenixTransaction> {
  const txData = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  });
  return getPhoenixEventsFromTransactionData(txData);
}

/**
 * Returns a list of Phoenix events for a given transaction signature
 *
 * @param connection The Solana `Connection` object
 * @param signature The signature of the transaction to fetch
 */
export async function getPhoneixEventsFromTransactionSignature(
  connection: Connection,
  signature: string
): Promise<PhoenixTransaction> {
  const txData = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  });
  return getPhoenixEventsFromTransactionData(txData);
}
