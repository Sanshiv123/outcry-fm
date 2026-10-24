"""Asset allowlist.

`gateway_asset_id` and `chain` are None until P1 verifies them with the Gateway's
list_assets call. In real mode an asset with no verified ID is NOT tradable (fail closed).
Stock symbols below are placeholders until we see what tokenized stocks the Gateway lists.
"""
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Asset:
    symbol: str
    name: str
    spoken_name: str
    mock_price: Decimal
    gateway_asset_id: str | None = None
    chain: str | None = None


QUOTE_SYMBOL = "USDC"

ASSETS: dict[str, Asset] = {
    a.symbol: a
    for a in [
        Asset("BTC", "Bitcoin", "Bitcoin", Decimal("67250")),
        Asset("ETH", "Ethereum", "Ether", Decimal("3480")),
        Asset("SOL", "Solana", "Solana", Decimal("168")),
        Asset("NVDA", "NVIDIA (tokenized)", "Nvidia", Decimal("182")),   # placeholder symbol
        Asset("TSLA", "Tesla (tokenized)", "Tesla", Decimal("248")),     # placeholder symbol
    ]
}


def tradable_symbols(mock_mode: bool) -> set[str]:
    if mock_mode:
        return set(ASSETS)
    return {s for s, a in ASSETS.items() if a.gateway_asset_id}


def spoken_list(symbols) -> str:
    names = [ASSETS[s].spoken_name for s in sorted(symbols) if s in ASSETS]
    if not names:
        return "nothing right now"
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
