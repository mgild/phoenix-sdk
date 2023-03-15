use borsh::{BorshDeserialize, BorshSerialize};
use phoenix::{
    quantities::{BaseLots, QuoteLots, Ticks},
    state::{SelfTradeBehavior, Side},
};

#[derive(BorshDeserialize, BorshSerialize)]
pub enum OrderPacketEnum {
    PostOnly,
    Limit,
    ImmediateOrCancel,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct DeprecatedPostOnlyPacket {
    side: Side,

    /// The price of the order, in ticks
    price_in_ticks: u64,

    /// Number of base lots to place on the book
    num_base_lots: u64,

    /// Client order id used to identify the order in the response to the client
    client_order_id: u128,

    /// Flag for whether or not to reject the order if it would immediately match or amend it to the best non-crossing price
    /// Default value is true
    reject_post_only: bool,

    /// Flag for whether or not the order should only use funds that are already in the account
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    use_only_deposited_funds: bool,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct PostOnlyPacket {
    pub side: Side,

    /// The price of the order, in ticks
    pub price_in_ticks: u64,

    /// Number of base lots to place on the book
    pub num_base_lots: u64,

    /// Client order id used to identify the order in the response to the client
    pub client_order_id: u128,

    /// Flag for whether or not to reject the order if it would immediately match or amend it to the best non-crossing price
    /// Default value is true
    pub reject_post_only: bool,

    /// Flag for whether or not the order should only use funds that are already in the account
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    pub use_only_deposited_funds: bool,

    /// If this is set, the order will be invalid after the specified slot
    pub last_valid_slot: Option<u64>,

    /// If this is set, the order will be invalid after the specified unix timestamp
    pub last_valid_unix_timestamp_in_seconds: Option<u64>,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct DeprecatedLimitPacket {
    side: Side,

    /// The price of the order, in ticks
    price_in_ticks: u64,

    /// Total number of base lots to place on the book or fill at a better price
    num_base_lots: u64,

    /// How the matching engine should handle a self trade
    self_trade_behavior: SelfTradeBehavior,

    /// Number of orders to match against. If this is `None` there is no limit
    match_limit: Option<u64>,

    /// Client order id used to identify the order in the response to the client
    client_order_id: u128,

    /// Flag for whether or not the order should only use funds that are already in the account.
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    use_only_deposited_funds: bool,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct LimitPacket {
    pub side: Side,

    /// The price of the order, in ticks
    pub price_in_ticks: u64,

    /// Total number of base lots to place on the book or fill at a better price
    pub num_base_lots: u64,

    /// How the matching engine should handle a self trade
    pub self_trade_behavior: SelfTradeBehavior,

    /// Number of orders to match against. If this is `None` there is no limit
    pub match_limit: Option<u64>,

    /// Client order id used to identify the order in the response to the client
    pub client_order_id: u128,

    /// Flag for whether or not the order should only use funds that are already in the account.
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    pub use_only_deposited_funds: bool,

    /// If this is set, the order will be invalid after the specified slot
    pub last_valid_slot: Option<u64>,

    /// If this is set, the order will be invalid after the specified unix timestamp
    pub last_valid_unix_timestamp_in_seconds: Option<u64>,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct DeprecatedImmediateOrCancelPacket {
    side: Side,

    /// The most aggressive price an order can be matched at. For example, if there is an IOC buy order
    /// to purchase 10 lots with the tick_per_lot parameter set to 10, then the order will never
    /// be matched at a price higher than 10 quote ticks per base unit. If this value is None, then the order
    /// is treated as a market order.
    price_in_ticks: Option<Ticks>,

    /// The number of base lots to fill against the order book. Either this parameter or the `num_quote_lots`
    /// parameter must be set to a nonzero value.
    num_base_lots: BaseLots,

    /// The number of quote lots to fill against the order book. Either this parameter or the `num_base_lots`
    /// parameter must be set to a nonzero value.
    num_quote_lots: QuoteLots,

    /// The minimum number of base lots to fill against the order book. If the order does not fill
    /// this many base lots, it will be voided.
    min_base_lots_to_fill: BaseLots,

    /// The minimum number of quote lots to fill against the order book. If the order does not fill
    /// this many quote lots, it will be voided.
    min_quote_lots_to_fill: QuoteLots,

    /// How the matching engine should handle a self trade.
    self_trade_behavior: SelfTradeBehavior,

    /// Number of orders to match against. If set to `None`, there is no limit.
    match_limit: Option<u64>,

    /// Client order id used to identify the order in the program's inner instruction data.
    client_order_id: u128,

    /// Flag for whether or not the order should only use funds that are already in the account.
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    use_only_deposited_funds: bool,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct ImmediateOrCancelPacket {
    side: Side,
    /// The most aggressive price an order can be matched at. For example, if there is an IOC buy order
    /// to purchase 10 lots with the tick_per_lot parameter set to 10, then the order will never
    /// be matched at a price higher than 10 quote ticks per base unit. If this value is None, then the order
    /// is treated as a market order.
    price_in_ticks: Option<Ticks>,
    /// The number of base lots to fill against the order book. Either this parameter or the `num_quote_lots`
    /// parameter must be set to a nonzero value.
    num_base_lots: BaseLots,
    /// The number of quote lots to fill against the order book. Either this parameter or the `num_base_lots`
    /// parameter must be set to a nonzero value.
    num_quote_lots: QuoteLots,
    /// The minimum number of base lots to fill against the order book. If the order does not fill
    /// this many base lots, it will be voided.
    min_base_lots_to_fill: BaseLots,
    /// The minimum number of quote lots to fill against the order book. If the order does not fill
    /// this many quote lots, it will be voided.
    min_quote_lots_to_fill: QuoteLots,
    /// How the matching engine should handle a self trade.
    self_trade_behavior: SelfTradeBehavior,
    /// Number of orders to match against. If set to `None`, there is no limit.
    match_limit: Option<u64>,
    /// Client order id used to identify the order in the program's inner instruction data.
    client_order_id: u128,
    /// Flag for whether or not the order should only use funds that are already in the account.
    /// Using only deposited funds will allow the trader to pass in less accounts per instruction and
    /// save transaction space as well as compute. This is only for traders who have a seat
    use_only_deposited_funds: bool,

    /// If this is set, the order will be invalid after the specified slot
    last_valid_slot: Option<u64>,

    /// If this is set, the order will be invalid after the specified unix timestamp
    last_valid_unix_timestamp_in_seconds: Option<u64>,
}

pub fn decode_post_only_packet_data(bytes: &[u8]) -> anyhow::Result<PostOnlyPacket> {
    let (tag, bytes) = bytes
        .split_first()
        .ok_or(anyhow::anyhow!("Invalid packet"))?;

    match OrderPacketEnum::try_from_slice(&[*tag])? {
        OrderPacketEnum::PostOnly => {
            let packet = PostOnlyPacket::try_from_slice(bytes)
                .map_err(|_| anyhow::Error::msg("Invalid Post-Only packet"));
            let deprecated_packet_result = DeprecatedPostOnlyPacket::try_from_slice(bytes);
            if packet.is_ok() {
                return packet;
            }
            let deprecated_packet = deprecated_packet_result?;
            let DeprecatedPostOnlyPacket {
                side,
                price_in_ticks,
                num_base_lots,
                client_order_id,
                reject_post_only,
                use_only_deposited_funds,
            } = deprecated_packet;
            Ok(PostOnlyPacket {
                side,
                price_in_ticks,
                num_base_lots,
                client_order_id,
                reject_post_only,
                use_only_deposited_funds,
                last_valid_slot: None,
                last_valid_unix_timestamp_in_seconds: None,
            })
        }
        _ => Err(anyhow::anyhow!("Invalid Post-Only packet")),
    }
}

pub fn decode_limit_packet_data(bytes: &[u8]) -> anyhow::Result<LimitPacket> {
    let (tag, bytes) = bytes
        .split_first()
        .ok_or(anyhow::anyhow!("Invalid packet"))?;

    match OrderPacketEnum::try_from_slice(&[*tag])? {
        OrderPacketEnum::Limit => {
            let packet = LimitPacket::try_from_slice(bytes)
                .map_err(|_| anyhow::Error::msg("Invalid Limit packet"));
            let deprecated_packet_result = DeprecatedLimitPacket::try_from_slice(bytes);
            if packet.is_ok() {
                return packet;
            }
            let deprecated_packet = deprecated_packet_result?;
            let DeprecatedLimitPacket {
                side,
                price_in_ticks,
                self_trade_behavior,
                match_limit,
                num_base_lots,
                client_order_id,
                use_only_deposited_funds,
            } = deprecated_packet;
            Ok(LimitPacket {
                side,
                price_in_ticks,
                self_trade_behavior,
                match_limit,
                num_base_lots,
                client_order_id,
                use_only_deposited_funds,
                last_valid_slot: None,
                last_valid_unix_timestamp_in_seconds: None,
            })
        }
        _ => Err(anyhow::anyhow!("Invalid Post-Only packet")),
    }
}

pub fn decode_ioc_packet_data(bytes: &[u8]) -> anyhow::Result<ImmediateOrCancelPacket> {
    let (tag, bytes) = bytes
        .split_first()
        .ok_or(anyhow::anyhow!("Invalid packet"))?;

    match OrderPacketEnum::try_from_slice(&[*tag])? {
        OrderPacketEnum::ImmediateOrCancel => {
            let packet = ImmediateOrCancelPacket::try_from_slice(bytes)
                .map_err(|_| anyhow::Error::msg("Invalid IOC packet"));
            let deprecated_packet_result = DeprecatedImmediateOrCancelPacket::try_from_slice(bytes);
            if packet.is_ok() {
                return packet;
            }
            let deprecated_packet = deprecated_packet_result?;
            let DeprecatedImmediateOrCancelPacket {
                side,
                price_in_ticks,
                num_base_lots,
                num_quote_lots,
                min_base_lots_to_fill,
                min_quote_lots_to_fill,
                self_trade_behavior,
                match_limit,
                client_order_id,
                use_only_deposited_funds,
            } = deprecated_packet;
            Ok(ImmediateOrCancelPacket {
                side,
                price_in_ticks,
                num_base_lots,
                num_quote_lots,
                min_base_lots_to_fill,
                min_quote_lots_to_fill,
                self_trade_behavior,
                match_limit,
                client_order_id,
                use_only_deposited_funds,
                last_valid_slot: None,
                last_valid_unix_timestamp_in_seconds: None,
            })
        }
        _ => Err(anyhow::anyhow!("Invalid Immediate or Cancel packet")),
    }
}
