use std::ops::Deref;

use phoenix::{
    quantities::WrapperU64,
    state::{
        markets::{FIFOOrderId, FIFORestingOrder, Ladder, Market},
        OrderPacket, Side,
    },
};
use solana_sdk::pubkey::Pubkey;

#[derive(Debug, Clone)]
pub struct SimulationSummaryInLots {
    pub base_lots_filled: u64,
    pub quote_lots_filled: u64,
}

impl Deref for LadderWithAdjustment {
    type Target = Ladder;
    fn deref(&self) -> &Self::Target {
        &self.ladder
    }
}

pub struct LadderWithAdjustment {
    ladder: Ladder,
    tick_size_in_quote_lots_per_base_unit: u64,
    base_lots_per_base_unit: u64,
}

impl LadderWithAdjustment {
    pub fn from_market(
        market: &dyn Market<Pubkey, FIFOOrderId, FIFORestingOrder, OrderPacket>,
    ) -> Self {
        Self {
            ladder: market.get_ladder(u64::MAX),
            tick_size_in_quote_lots_per_base_unit: market.get_tick_size().as_u64(),
            base_lots_per_base_unit: market.get_base_lots_per_base_unit().as_u64(),
        }
    }

    pub fn from_market_with_expiration(
        market: &dyn Market<Pubkey, FIFOOrderId, FIFORestingOrder, OrderPacket>,
        last_valid_slot: Option<u64>,
        last_valid_unix_timestamp_in_seconds: Option<u64>,
    ) -> Self {
        Self {
            ladder: market.get_ladder_with_expiration(
                u64::MAX,
                last_valid_slot,
                last_valid_unix_timestamp_in_seconds,
            ),
            tick_size_in_quote_lots_per_base_unit: market.get_tick_size().as_u64(),
            base_lots_per_base_unit: market.get_base_lots_per_base_unit().as_u64(),
        }
    }
}

pub trait MarketSimulator {
    fn sell_quote(&self, num_lots_quote: u64) -> SimulationSummaryInLots;
    fn sell_base(&self, num_lots_base: u64) -> SimulationSummaryInLots;
    fn simulate_market_sell(&self, side: Side, size_in_lots: u64) -> SimulationSummaryInLots;
}

impl MarketSimulator for LadderWithAdjustment {
    fn sell_quote(&self, num_lots_quote: u64) -> SimulationSummaryInLots {
        let adjusted_quote_lots = num_lots_quote * self.base_lots_per_base_unit;
        let mut remaining_adjusted_quote_lots = adjusted_quote_lots;
        let mut base_lots = 0;

        for ask in self.asks.iter() {
            if remaining_adjusted_quote_lots == 0 {
                break;
            }

            let max_base_lots_you_can_buy = remaining_adjusted_quote_lots
                / (ask.price_in_ticks * self.tick_size_in_quote_lots_per_base_unit);
            let amount_lots_to_buy = max_base_lots_you_can_buy.min(ask.size_in_base_lots);
            base_lots += amount_lots_to_buy;
            remaining_adjusted_quote_lots -= amount_lots_to_buy
                * (ask.price_in_ticks * self.tick_size_in_quote_lots_per_base_unit);
        }

        let quote_lots_used =
            (adjusted_quote_lots - remaining_adjusted_quote_lots) / self.base_lots_per_base_unit;
        SimulationSummaryInLots {
            base_lots_filled: base_lots,
            quote_lots_filled: quote_lots_used,
        }
    }

    fn sell_base(&self, num_lots_base: u64) -> SimulationSummaryInLots {
        let mut remaining_base_lots = num_lots_base;
        let mut adjusted_quote_lots = 0;

        for bid in self.bids.iter() {
            if remaining_base_lots == 0 {
                break;
            }

            let lots_to_fill = remaining_base_lots.min(bid.size_in_base_lots);
            adjusted_quote_lots +=
                lots_to_fill * bid.price_in_ticks * self.tick_size_in_quote_lots_per_base_unit;
            remaining_base_lots -= lots_to_fill;
        }

        let base_lots_used = num_lots_base - remaining_base_lots;
        SimulationSummaryInLots {
            base_lots_filled: base_lots_used,
            quote_lots_filled: adjusted_quote_lots / self.base_lots_per_base_unit,
        }
    }

    fn simulate_market_sell(&self, side: Side, size_in_lots: u64) -> SimulationSummaryInLots {
        match side {
            Side::Bid => self.sell_quote(size_in_lots),
            Side::Ask => self.sell_base(size_in_lots),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use phoenix::state::markets::LadderOrder;

    struct Fixture {
        pub ladder: LadderWithAdjustment,
        pub atoms_in_base_lot: f64,
        pub atoms_in_quote_lot: f64,
        pub atoms_in_base_unit: f64,
        pub atoms_in_quote_unit: f64,
    }

    // This is a very simplified ladder for SOL/USDC on Phoenix
    fn get_sol_usdc_ladder() -> Fixture {
        let ladder = Ladder {
            bids: vec![
                LadderOrder {
                    price_in_ticks: 0x58bf,
                    size_in_base_lots: 0x043f,
                },
                LadderOrder {
                    price_in_ticks: 0x58b9,
                    size_in_base_lots: 0x043f,
                },
                LadderOrder {
                    price_in_ticks: 0x58a7,
                    size_in_base_lots: 0x043f,
                },
            ],
            asks: vec![
                LadderOrder {
                    price_in_ticks: 0x58c0,
                    size_in_base_lots: 0x3036,
                },
                LadderOrder {
                    price_in_ticks: 0x58c0,
                    size_in_base_lots: 0x01e1ff,
                },
                LadderOrder {
                    price_in_ticks: 0x58c0,
                    size_in_base_lots: 0x02a261,
                },
            ],
        };
        let fixture = Fixture {
            ladder: LadderWithAdjustment {
                ladder,
                tick_size_in_quote_lots_per_base_unit: 1000,
                base_lots_per_base_unit: 1000,
            },
            atoms_in_base_lot: 1e6,
            atoms_in_quote_lot: 1.,
            atoms_in_base_unit: 1e9,
            atoms_in_quote_unit: 1e6,
        };
        fixture
    }

    fn lots_to_unit_amount(lots: u64, lots_to_atoms: f64, atoms_to_unit: f64) -> f64 {
        let atoms = lots_to_atoms * lots as f64;
        let unit = atoms / atoms_to_unit;
        unit
    }

    #[test]
    fn test_empty_ladder_sell() {
        let ladder = LadderWithAdjustment {
            ladder: Ladder {
                bids: vec![],
                asks: vec![],
            },
            tick_size_in_quote_lots_per_base_unit: 1000,
            base_lots_per_base_unit: 1000,
        };
        let result = ladder.simulate_market_sell(Side::Ask, 1000);
        assert_eq!(result.base_lots_filled, 0);
        assert_eq!(result.quote_lots_filled, 0);
    }

    #[test]
    fn test_sell_more_than_available() {
        let Fixture { ladder, .. } = get_sol_usdc_ladder();

        // Compute the max lots you can sell
        let max_lots_purchaseable: u64 = ladder.bids.iter().map(|bid| bid.size_in_base_lots).sum();

        // Sell twice as much, and assert that only the max is filled
        let to_purchase = max_lots_purchaseable * 2;
        let result = ladder.simulate_market_sell(Side::Ask, to_purchase);
        assert_eq!(result.base_lots_filled, max_lots_purchaseable);
        assert!(result.quote_lots_filled > 0);
    }

    #[test]
    fn test_buy_more_than_available() {
        let Fixture { ladder, .. } = get_sol_usdc_ladder();

        // Compute the max lots you can buy (from available asks)
        let max_lots_sellable = ladder
            .asks
            .iter()
            .map(|ask| {
                ask.size_in_base_lots
                    * ask.price_in_ticks
                    * ladder.tick_size_in_quote_lots_per_base_unit
            })
            .sum::<u64>()
            / ladder.base_lots_per_base_unit;

        // Try to buy twice as much, which means you are selling twice as much base
        let to_sell = max_lots_sellable * 2;
        let result: SimulationSummaryInLots = ladder.simulate_market_sell(Side::Bid, to_sell);

        assert_eq!(result.quote_lots_filled, max_lots_sellable);
        assert!(result.quote_lots_filled > 0);
    }

    #[test]
    fn test_simulate_market() {
        let test_cases = vec![
            (Side::Ask, 3000, 3000, 68130654, "22.710"),
            (Side::Ask, 6000, 3261, 74054049, "22.709"),
            (Side::Bid, 68000000, 2992, 67978240, "22.720"),
            (Side::Ask, 0, 0, 0, "0.000"),
            (Side::Bid, 0, 0, 0, "0.000"),
        ];

        for (side, input, expected_base, expected_quote, expected_price) in test_cases.into_iter() {
            let fixture = get_sol_usdc_ladder();
            let ladder = fixture.ladder;
            let result = ladder.simulate_market_sell(side, input);
            assert_eq!(
                result.base_lots_filled, expected_base,
                "Failed for side {:?} with input {}",
                side, input
            );
            assert_eq!(
                result.quote_lots_filled, expected_quote,
                "Failed for side {:?} with input {}",
                side, input
            );
            let price = match result.base_lots_filled {
                0 => 0.0,
                _ => {
                    let base_units = lots_to_unit_amount(
                        result.base_lots_filled,
                        fixture.atoms_in_base_lot,
                        fixture.atoms_in_base_unit,
                    );
                    let quote_units = lots_to_unit_amount(
                        result.quote_lots_filled,
                        fixture.atoms_in_quote_lot,
                        fixture.atoms_in_quote_unit,
                    );
                    quote_units / base_units
                }
            };
            let price_formatted = format!("{:.3}", price);
            assert_eq!(
                price_formatted, expected_price,
                "Price mismatch for side {:?} with input {}",
                side, input
            );
        }
    }
}
