import os
from dataclasses import dataclass
from decimal import Decimal

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    mock_mode: bool
    wallet_model: str  # "org_custodial" | "user_account" (pending True Markets confirmation)
    max_order_usd: Decimal
    max_daily_usd: Decimal
    intent_ttl_s: int
    price_max_age_s: int
    price_cache_s: int
    fee_bps: int
    max_funded_wallets: int
    fund_amount_usd: Decimal
    station_wallet_address: str | None
    agent_tool_secret: str | None
    elevenlabs_agent_id: str | None


def load_settings() -> Settings:
    return Settings(
        mock_mode=_bool("MOCK_MODE", True),
        wallet_model=os.getenv("WALLET_MODEL", "org_custodial"),
        max_order_usd=Decimal(os.getenv("MAX_ORDER_USD", "5")),
        max_daily_usd=Decimal(os.getenv("MAX_DAILY_USD", "20")),
        intent_ttl_s=int(os.getenv("INTENT_TTL_S", "30")),
        price_max_age_s=int(os.getenv("PRICE_MAX_AGE_S", "60")),
        price_cache_s=int(os.getenv("PRICE_CACHE_S", "5")),
        fee_bps=int(os.getenv("FEE_BPS", "20")),
        max_funded_wallets=int(os.getenv("MAX_FUNDED_WALLETS", "6")),
        fund_amount_usd=Decimal(os.getenv("FUND_AMOUNT_USD", "3")),
        station_wallet_address=os.getenv("STATION_WALLET_ADDRESS") or None,
        agent_tool_secret=os.getenv("AGENT_TOOL_SECRET") or None,
        elevenlabs_agent_id=os.getenv("ELEVENLABS_AGENT_ID") or None,
    )


settings = load_settings()
